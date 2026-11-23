//! Files the farm keeps (VibeValley `platform/attachment`): each once by
//! the sha256 of its bytes, at `<home>/attachments/<sha256>`, described in
//! `server.db`'s `attachment` table. `attachment.create` as VibeValley
//! serves it, and VibeValley's `attachment.file` (the file's absolute path).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use sha2::{Digest, Sha256};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, Attachment, AttachmentFile, AttachmentImportPathInput, AttachmentUpload, BizCode, native_ops, ops};

use crate::base::{ServerDb, internal};
use crate::db::generated::content_attachment as queries;
use crate::{Hub, now};

/// `attachmentMax`: 25 MB.
pub const ATTACHMENT_MAX: usize = 25 * 1024 * 1024;

pub struct Attachments {
    root: PathBuf,
    db: Arc<ServerDb>,
}

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::AttachmentRefused, text)
}

/// `missing(…, [])`: a miss with nowhere to look is `NotFound`.
fn no_attachment(id: &str) -> ApiError {
    ApiError::new(BizCode::NotFound, t("server.attachment.noAttachment", &[("id", id.into())]))
}

impl Attachments {
    pub fn open(home: &Path, db: Arc<ServerDb>) -> Arc<Attachments> {
        Arc::new(Attachments {
            root: home.join("attachments"),
            db,
        })
    }

    /// `pathOf`: where an attachment's bytes are (or would be).
    pub fn path_of(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    /// `attach`: an upload, as base64, kept.
    pub fn attach(&self, upload: &AttachmentUpload) -> Result<Attachment, ApiError> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(upload.data.trim())
            .map_err(|e| ApiError::new(BizCode::InvalidInput, format!("data: {e}")))?;
        if bytes.len() > ATTACHMENT_MAX {
            return Err(file_too_big());
        }
        self.keep(&bytes, &upload.name, &upload.r#type)
    }

    pub async fn attach_async(&self, upload: AttachmentUpload) -> Result<Attachment, ApiError> {
        let root = self.root.clone();
        let data = upload.data;
        let (id, size) = tokio::task::spawn_blocking(move || -> Result<(String, i64), ApiError> {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .map_err(|e| ApiError::new(BizCode::InvalidInput, format!("data: {e}")))?;
            if bytes.len() > ATTACHMENT_MAX {
                return Err(file_too_big());
            }
            if bytes.is_empty() {
                return Err(refused(t("server.attachment.emptyFile", &[])));
            }
            let id = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();
            write_once_at(&root, &id, &bytes).map_err(|e| refused(e.to_string()))?;
            Ok((id, bytes.len() as i64))
        })
        .await
        .map_err(internal)??;
        self.record_async(&id, &upload.name, &upload.r#type, size).await
    }

    /// Streams a local regular file directly from disk into CAS without base64 framing (`Caller::User` only).
    pub fn import_path(&self, input: &AttachmentImportPathInput) -> Result<Attachment, ApiError> {
        let (id, name, mime, size) = stream_import_to_cas(&self.root, input)?;
        self.record(&id, &name, &mime, size)
    }

    pub async fn import_path_async(&self, input: AttachmentImportPathInput) -> Result<Attachment, ApiError> {
        let root = self.root.clone();
        let (id, name, mime, size) = tokio::task::spawn_blocking(move || stream_import_to_cas(&root, &input))
            .await
            .map_err(internal)??;
        self.record_async(&id, &name, &mime, size).await
    }

    /// `keep`: bytes kept once by their sha256; no size limit.
    pub fn keep(&self, bytes: &[u8], name: &str, kind: &str) -> Result<Attachment, ApiError> {
        if bytes.is_empty() {
            return Err(refused(t("server.attachment.emptyFile", &[])));
        }
        let id = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();
        write_once_at(&self.root, &id, bytes).map_err(|e| refused(e.to_string()))?;
        self.record(&id, name, kind, bytes.len() as i64)
    }

    pub async fn keep_async(&self, bytes: Vec<u8>, name: String, kind: String) -> Result<Attachment, ApiError> {
        if bytes.is_empty() {
            return Err(refused(t("server.attachment.emptyFile", &[])));
        }
        let root = self.root.clone();
        let (id, size) = tokio::task::spawn_blocking(move || -> Result<(String, i64), ApiError> {
            let id = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();
            write_once_at(&root, &id, &bytes).map_err(|e| refused(e.to_string()))?;
            Ok((id, bytes.len() as i64))
        })
        .await
        .map_err(internal)??;
        self.record_async(&id, &name, &kind, size).await
    }

    /// Promote a verified private staging file on the same filesystem. The
    /// media input row records the intended hash before this is called.
    pub(crate) async fn keep_staged_async(&self, path: PathBuf, hash: String, size: i64, name: String, kind: String) -> Result<Attachment, ApiError> {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(refused("invalid content hash".into()));
        }
        let root = self.root.clone();
        let target = self.path_of(&hash);
        tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
            std::fs::create_dir_all(&root).map_err(|e| refused(e.to_string()))?;
            std::fs::rename(&path, &target).map_err(|e| refused(e.to_string()))?;
            Ok(())
        })
        .await
        .map_err(internal)??;
        self.record_async(&hash, &name, &kind, size).await
    }

    fn record(&self, id: &str, given: &str, given_type: &str, size: i64) -> Result<Attachment, ApiError> {
        let name = if given.trim().is_empty() { "file" } else { given.trim() };
        let kind = if given_type.trim().is_empty() {
            "application/octet-stream"
        } else {
            given_type.trim()
        };
        self.db
            .run(async |c| {
                queries::keep_attachment(
                    c,
                    queries::KeepAttachmentParams {
                        id: id.into(),
                        name: name.into(),
                        r#type: kind.into(),
                        size,
                        created_at: now(),
                    },
                )
                .await
            })
            .map_err(internal)?;
        Ok(Attachment {
            id: id.into(),
            name: name.into(),
            r#type: kind.into(),
            size,
        })
    }

    async fn record_async(&self, id: &str, given: &str, given_type: &str, size: i64) -> Result<Attachment, ApiError> {
        let name = if given.trim().is_empty() { "file" } else { given.trim() };
        let kind = if given_type.trim().is_empty() {
            "application/octet-stream"
        } else {
            given_type.trim()
        };
        let mut conn = self.db.write_pool().acquire().await.map_err(internal)?;
        queries::keep_attachment(
            &mut *conn,
            queries::KeepAttachmentParams {
                id: id.into(),
                name: name.into(),
                r#type: kind.into(),
                size,
                created_at: now(),
            },
        )
        .await
        .map_err(internal)?;
        Ok(Attachment {
            id: id.into(),
            name: name.into(),
            r#type: kind.into(),
            size,
        })
    }

    fn by_id(&self, id: &str) -> Result<Option<Attachment>, ApiError> {
        match self
            .db
            .read(async |c| queries::get_attachment(c, queries::GetAttachmentParams { id: id.into() }).await)
        {
            Ok(row) => Ok(Some(Attachment {
                id: row.id,
                name: row.name,
                r#type: row.r#type,
                size: row.size,
            })),
            Err(sqlx::Error::RowNotFound) => Ok(None),
            Err(error) => Err(internal(error)),
        }
    }

    pub async fn by_id_async(&self, id: &str) -> Result<Option<Attachment>, ApiError> {
        let mut conn = self.db.read_pool().acquire().await.map_err(internal)?;
        match queries::get_attachment(&mut *conn, queries::GetAttachmentParams { id: id.into() }).await {
            Ok(row) => Ok(Some(Attachment {
                id: row.id,
                name: row.name,
                r#type: row.r#type,
                size: row.size,
            })),
            Err(sqlx::Error::RowNotFound) => Ok(None),
            Err(error) => Err(internal(error)),
        }
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

    pub async fn of_async(&self, ids: &[String]) -> Result<Vec<Attachment>, ApiError> {
        let mut out: Vec<Attachment> = vec![];
        for id in ids {
            if out.iter().any(|a| &a.id == id) {
                continue;
            }
            out.push(self.by_id_async(id).await?.ok_or_else(|| no_attachment(id))?);
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

    pub async fn file_async(&self, id: &str) -> Result<AttachmentFile, ApiError> {
        let a = self.by_id_async(id).await?.ok_or_else(|| no_attachment(id))?;
        let path = self.path_of(&a.id);
        if !tokio::fs::metadata(&path).await.is_ok_and(|m| m.is_file()) {
            return Err(no_attachment(id));
        }
        Ok(AttachmentFile {
            path: path.to_string_lossy().into_owned(),
            r#type: a.r#type,
            name: a.name,
        })
    }
}

/// `writeOnce`: a file already there with these bytes is left; a new
/// one is written beside it first, so nobody reads half of it.
fn write_once_at(root: &Path, id: &str, bytes: &[u8]) -> std::io::Result<()> {
    let target = root.join(id);
    if std::fs::metadata(&target).is_ok_and(|m| m.len() == bytes.len() as u64) {
        return Ok(());
    }
    std::fs::create_dir_all(root)?;
    let staging = root.join(format!(".put-{}", uuid::Uuid::new_v4()));
    let mut f = std::fs::File::create(&staging)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&staging, &target)
}

fn stream_import_to_cas(root: &Path, input: &AttachmentImportPathInput) -> Result<(String, String, String, i64), ApiError> {
    let raw = input.path.trim();
    let path = Path::new(raw);
    if raw.is_empty() || !path.is_absolute() {
        return Err(ApiError::new(BizCode::InvalidInput, "path must be an absolute path to a regular file"));
    }
    let sym_meta = std::fs::symlink_metadata(path).map_err(|e| refused(format!("{}: {e}", path.display())))?;
    if sym_meta.file_type().is_symlink() {
        return Err(refused("symlinks cannot be imported as attachments".into()));
    }
    if !sym_meta.file_type().is_file() {
        return Err(refused(format!("{} is not a regular file", path.display())));
    }
    if sym_meta.len() == 0 {
        return Err(refused(t("server.attachment.emptyFile", &[])));
    }
    if sym_meta.len() > ATTACHMENT_MAX as u64 {
        return Err(file_too_big());
    }

    let mut source = std::fs::File::open(path).map_err(|e| refused(format!("{}: {e}", path.display())))?;
    let file_meta = source.metadata().map_err(|e| refused(format!("{}: {e}", path.display())))?;
    if !file_meta.is_file() {
        return Err(refused(format!("{} is not a regular file", path.display())));
    }
    if file_meta.len() > ATTACHMENT_MAX as u64 {
        return Err(file_too_big());
    }

    std::fs::create_dir_all(root).map_err(|e| refused(e.to_string()))?;
    let staging = root.join(format!(".put-{}", uuid::Uuid::new_v4()));
    let streamed = (|| -> Result<(String, i64), ApiError> {
        let mut dest = std::fs::File::create(&staging).map_err(|e| refused(e.to_string()))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        let mut total: u64 = 0;
        loop {
            let n = source.read(&mut buf).map_err(|e| refused(e.to_string()))?;
            if n == 0 {
                break;
            }
            total = total.saturating_add(n as u64);
            if total > ATTACHMENT_MAX as u64 {
                return Err(file_too_big());
            }
            hasher.update(&buf[..n]);
            dest.write_all(&buf[..n]).map_err(|e| refused(e.to_string()))?;
        }
        if total == 0 {
            return Err(refused(t("server.attachment.emptyFile", &[])));
        }
        dest.sync_all().map_err(|e| refused(e.to_string()))?;
        let id = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
        Ok((id, total as i64))
    })();

    let (id, size) = match streamed {
        Ok(pair) => pair,
        Err(err) => {
            let _ = std::fs::remove_file(&staging);
            return Err(err);
        }
    };

    let target = root.join(&id);
    if std::fs::metadata(&target).is_ok_and(|m| m.len() == size as u64) {
        let _ = std::fs::remove_file(&staging);
    } else if let Err(err) = std::fs::rename(&staging, &target) {
        let _ = std::fs::remove_file(&staging);
        return Err(refused(err.to_string()));
    }

    let fallback_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_name)
        .to_owned();
    let mime = input
        .mime
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| guess_mime_from_path(path))
        .to_owned();
    Ok((id, name, mime, size))
}

impl crate::ports::AttachmentReadPort for Attachments {
    fn read_bytes(&self, id: &str) -> Result<(String, Vec<u8>), ApiError> {
        let file = self.file(id)?;
        let bytes = std::fs::read(&file.path).map_err(|_| no_attachment(id))?;
        Ok((file.r#type, bytes))
    }
}

fn file_too_big() -> ApiError {
    refused(t(
        "server.attachment.fileTooBig",
        &[("mb", ((ATTACHMENT_MAX as f64) / 1024.0 / 1024.0).round().into())],
    ))
}

fn guess_mime_from_path(path: &Path) -> &'static str {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

pub fn install(hub: &Hub, files: Arc<Attachments>) {
    hub.on_async::<ops::AttachmentCreate, _, _>({
        let files = files.clone();
        move |_, upload| {
            let files = files.clone();
            async move { files.attach_async(upload).await }
        }
    });
    hub.on_async::<ops::AttachmentImportPath, _, _>({
        let files = files.clone();
        move |_, input| {
            let files = files.clone();
            async move { files.import_path_async(input).await }
        }
    });
    hub.on_async::<native_ops::AttachmentFile, _, _>(move |_, i| {
        let files = files.clone();
        async move { files.file_async(&i.id).await }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use vibevalley_protocol::Caller;

    fn test_hub() -> (tempfile::TempDir, Arc<Hub>, Arc<Attachments>) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = ServerDb::open(dir.path()).expect("open db");
        let files = Attachments::open(dir.path(), db);
        let hub = Hub::new(vibevalley_core::empty_space_state());
        install(&hub, files.clone());
        (dir, hub, files)
    }

    #[test]
    fn import_path_succeeds_for_local_user_and_rejects_remote_caller_with_forbidden() {
        let (dir, hub, files) = test_hub();
        let sample = dir.path().join("diagram.png");
        let payload = b"\x89PNG\r\n\x1a\nlocal-import-bytes";
        std::fs::write(&sample, payload).expect("write sample");

        let user_env = hub.call_as(Caller::User, "attachment.importPath", json!({ "path": sample.to_string_lossy() }));
        assert_eq!(user_env.biz_code, 0, "local user must succeed: {}", user_env.message);
        let att: Attachment = serde_json::from_value(user_env.data.expect("data")).expect("attachment");
        assert_eq!(att.name, "diagram.png");
        assert_eq!(att.r#type, "image/png");
        assert_eq!(att.size, payload.len() as i64);
        assert_eq!(std::fs::read(files.path_of(&att.id)).expect("cas bytes"), payload);

        // Deduplicates with identical content via base64 attachment.create.
        let b64 = base64::engine::general_purpose::STANDARD.encode(payload);
        let created = hub.call_as(
            Caller::User,
            "attachment.create",
            json!({ "name": "copy.png", "type": "image/png", "data": b64 }),
        );
        assert_eq!(created.biz_code, 0);
        let att2: Attachment = serde_json::from_value(created.data.expect("data")).expect("attachment");
        assert_eq!(att.id, att2.id);

        // Remote caller MUST be rejected with Forbidden.
        let remote_env = hub.call_as(Caller::Remote, "attachment.importPath", json!({ "path": sample.to_string_lossy() }));
        assert_eq!(
            remote_env.biz_code,
            BizCode::Forbidden.code(),
            "remote caller must receive Forbidden, got: {:?}",
            remote_env
        );
    }

    #[test]
    fn import_path_enforces_absolute_regular_non_symlink_and_size_checks() {
        let (dir, hub, _) = test_hub();

        let rel = hub.call_as(Caller::User, "attachment.importPath", json!({ "path": "relative/file.txt" }));
        assert_eq!(rel.biz_code, BizCode::InvalidInput.code());

        let subdir = dir.path().join("folder");
        std::fs::create_dir_all(&subdir).expect("mkdir");
        let dir_res = hub.call_as(Caller::User, "attachment.importPath", json!({ "path": subdir.to_string_lossy() }));
        assert_eq!(dir_res.biz_code, BizCode::AttachmentRefused.code());

        let empty = dir.path().join("empty.txt");
        std::fs::write(&empty, b"").expect("write empty");
        let empty_res = hub.call_as(Caller::User, "attachment.importPath", json!({ "path": empty.to_string_lossy() }));
        assert_eq!(empty_res.biz_code, BizCode::AttachmentRefused.code());

        #[cfg(unix)]
        {
            let target = dir.path().join("real.txt");
            let link = dir.path().join("link.txt");
            std::fs::write(&target, b"secret").expect("write target");
            std::os::unix::fs::symlink(&target, &link).expect("symlink");
            let link_res = hub.call_as(Caller::User, "attachment.importPath", json!({ "path": link.to_string_lossy() }));
            assert_eq!(link_res.biz_code, BizCode::AttachmentRefused.code());
        }

        // Explicit name and mime override extension defaults.
        let custom = dir.path().join("blob");
        std::fs::write(&custom, b"hello world").expect("write custom");
        let custom_res = hub.call_as(
            Caller::User,
            "attachment.importPath",
            json!({ "path": custom.to_string_lossy(), "name": "notes.md", "mime": "text/markdown" }),
        );
        assert_eq!(custom_res.biz_code, 0);
        let att: Attachment = serde_json::from_value(custom_res.data.expect("data")).expect("attachment");
        assert_eq!(att.name, "notes.md");
        assert_eq!(att.r#type, "text/markdown");
        assert_eq!(att.size, 11);
    }
}
