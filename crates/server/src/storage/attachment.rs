//! Content-addressed attachment storage: each file kept once by the SHA-256
//! of its bytes at `<home>/attachments/<sha256>` and indexed via `ctx.service.storage`.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use sha2::{Digest, Sha256};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, Attachment, AttachmentFile, AttachmentImportPathInput, AttachmentUpload, BizCode};

use crate::context::{Context, internal};
use crate::log::spawn_blocking_traced;

/// Maximum uploaded attachment size (25 MB).
pub const ATTACHMENT_MAX: usize = 25 * 1024 * 1024;

/// Content-addressed attachment file store backed by `<home>/attachments` and [`crate::service::StorageService`].
pub struct AttachmentStorage {
    root: PathBuf,
    ctx: Arc<Context>,
}

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::AttachmentRefused, text)
}

fn no_attachment(id: &str) -> ApiError {
    ApiError::new(BizCode::NotFound, t("server.attachment.noAttachment", &[("id", id.into())]))
}

impl AttachmentStorage {
    pub fn open(home: &Path, ctx: Arc<Context>) -> Arc<Self> {
        Arc::new(Self {
            root: home.join("attachments"),
            ctx,
        })
    }

    /// Filesystem path where an attachment's bytes live.
    pub fn path_of(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    /// Decodes a base64 upload, writes it to CAS, and records metadata.
    pub async fn attach_async(&self, upload: AttachmentUpload) -> Result<Attachment, ApiError> {
        let root = self.root.clone();
        let data = upload.data;
        let (id, size) = spawn_blocking_traced(move || -> Result<(String, i64), ApiError> {
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
    pub async fn import_path_async(&self, input: AttachmentImportPathInput) -> Result<Attachment, ApiError> {
        let root = self.root.clone();
        let (id, name, mime, size) = spawn_blocking_traced(move || stream_import_to_cas(&root, &input)).await.map_err(internal)??;
        self.record_async(&id, &name, &mime, size).await
    }

    /// Stores raw bytes once by their SHA-256 with no upload size cap.
    pub async fn keep_async(&self, bytes: Vec<u8>, name: String, kind: String) -> Result<Attachment, ApiError> {
        if bytes.is_empty() {
            return Err(refused(t("server.attachment.emptyFile", &[])));
        }
        let root = self.root.clone();
        let (id, size) = spawn_blocking_traced(move || -> Result<(String, i64), ApiError> {
            let id = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();
            write_once_at(&root, &id, &bytes).map_err(|e| refused(e.to_string()))?;
            Ok((id, bytes.len() as i64))
        })
        .await
        .map_err(internal)??;
        self.record_async(&id, &name, &kind, size).await
    }

    /// Promotes a verified private staging file on the same filesystem into CAS.
    pub(crate) async fn keep_staged_async(&self, path: PathBuf, hash: String, size: i64, name: String, kind: String) -> Result<Attachment, ApiError> {
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(refused("invalid content hash".into()));
        }
        let root = self.root.clone();
        let target = self.path_of(&hash);
        spawn_blocking_traced(move || -> Result<(), ApiError> {
            std::fs::create_dir_all(&root).map_err(|e| refused(e.to_string()))?;
            std::fs::rename(&path, &target).map_err(|e| refused(e.to_string()))?;
            Ok(())
        })
        .await
        .map_err(internal)??;
        self.record_async(&hash, &name, &kind, size).await
    }

    async fn record_async(&self, id: &str, given: &str, given_type: &str, size: i64) -> Result<Attachment, ApiError> {
        let name = if given.trim().is_empty() { "file" } else { given.trim() };
        let kind = if given_type.trim().is_empty() {
            "application/octet-stream"
        } else {
            given_type.trim()
        };
        self.ctx
            .service
            .storage
            .insert_attachment(id, name, kind, size, self.ctx.now())
            .await
            .map_err(internal)?;
        Ok(Attachment {
            id: id.into(),
            name: name.into(),
            r#type: kind.into(),
            size,
        })
    }

    pub async fn by_id_async(&self, id: &str) -> Result<Option<Attachment>, ApiError> {
        self.ctx.service.storage.find_attachment(id).await.map_err(internal)
    }

    /// Resolves a deduplicated ordered list of attachment ids; fails if any id is missing.
    pub async fn of_async(&self, ids: &[String]) -> Result<Vec<Attachment>, ApiError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let map = self.ctx.service.storage.find_attachments_map(ids).await.map_err(internal)?;
        let mut out: Vec<Attachment> = Vec::with_capacity(ids.len());
        for id in ids {
            if out.iter().any(|a| &a.id == id) {
                continue;
            }
            let att = map.get(id).cloned().ok_or_else(|| no_attachment(id))?;
            out.push(att);
        }
        Ok(out)
    }

    /// Returns the absolute filesystem path and media type for a kept attachment.
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

    /// Reads a kept attachment's media type and raw bytes asynchronously.
    pub async fn read_bytes_async(&self, id: &str) -> Result<(String, Vec<u8>), ApiError> {
        let file = self.file_async(id).await?;
        let bytes = tokio::fs::read(&file.path).await.map_err(|_| no_attachment(id))?;
        Ok((file.r#type, bytes))
    }
}

/// Writes bytes via a sibling temp file + atomic rename so readers never observe partial content.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
    use crate::service::Service;

    async fn test_storage() -> (tempfile::TempDir, Arc<Context>, Arc<AttachmentStorage>) {
        let dir = tempfile::tempdir().expect("tempdir");
        let service = Service::open(dir.path()).await.expect("open service");
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            Arc::new(Outbox::new(service)),
            Arc::new(StateFeed::new()),
            vibevalley_core::system_clock(),
            Arc::new(Http),
            Arc::new(PublicDownload),
        ));
        let files = AttachmentStorage::open(dir.path(), ctx.clone());
        (dir, ctx, files)
    }

    #[tokio::test]
    async fn import_path_and_create_deduplicate_by_content_hash() {
        let (dir, ctx, files) = test_storage().await;
        let sample = dir.path().join("diagram.png");
        let payload = b"\x89PNG\r\n\x1a\nlocal-import-bytes";
        std::fs::write(&sample, payload).expect("write sample");

        let att = files
            .import_path_async(AttachmentImportPathInput {
                path: sample.to_string_lossy().into_owned(),
                name: None,
                mime: None,
            })
            .await
            .expect("import path");
        assert_eq!(att.name, "diagram.png");
        assert_eq!(att.r#type, "image/png");
        assert_eq!(att.size, payload.len() as i64);
        assert_eq!(std::fs::read(files.path_of(&att.id)).expect("cas bytes"), payload);

        let b64 = base64::engine::general_purpose::STANDARD.encode(payload);
        let att2 = files
            .attach_async(AttachmentUpload {
                name: "copy.png".into(),
                r#type: "image/png".into(),
                data: b64,
            })
            .await
            .expect("attach");
        assert_eq!(att.id, att2.id);

        ctx.service.close().await;
    }

    #[tokio::test]
    async fn import_path_enforces_absolute_regular_non_symlink_and_size_checks() {
        let (dir, ctx, files) = test_storage().await;

        let rel = files
            .import_path_async(AttachmentImportPathInput {
                path: "relative/file.txt".into(),
                name: None,
                mime: None,
            })
            .await;
        assert_eq!(rel.unwrap_err().biz_code, BizCode::InvalidInput);

        let subdir = dir.path().join("folder");
        std::fs::create_dir_all(&subdir).expect("mkdir");
        let dir_res = files
            .import_path_async(AttachmentImportPathInput {
                path: subdir.to_string_lossy().into_owned(),
                name: None,
                mime: None,
            })
            .await;
        assert_eq!(dir_res.unwrap_err().biz_code, BizCode::AttachmentRefused);

        let empty = dir.path().join("empty.txt");
        std::fs::write(&empty, b"").expect("write empty");
        let empty_res = files
            .import_path_async(AttachmentImportPathInput {
                path: empty.to_string_lossy().into_owned(),
                name: None,
                mime: None,
            })
            .await;
        assert_eq!(empty_res.unwrap_err().biz_code, BizCode::AttachmentRefused);

        #[cfg(unix)]
        {
            let target = dir.path().join("real.txt");
            let link = dir.path().join("link.txt");
            std::fs::write(&target, b"secret").expect("write target");
            std::os::unix::fs::symlink(&target, &link).expect("symlink");
            let link_res = files
                .import_path_async(AttachmentImportPathInput {
                    path: link.to_string_lossy().into_owned(),
                    name: None,
                    mime: None,
                })
                .await;
            assert_eq!(link_res.unwrap_err().biz_code, BizCode::AttachmentRefused);
        }

        let custom = dir.path().join("blob");
        std::fs::write(&custom, b"hello world").expect("write custom");
        let att = files
            .import_path_async(AttachmentImportPathInput {
                path: custom.to_string_lossy().into_owned(),
                name: Some("notes.md".into()),
                mime: Some("text/markdown".into()),
            })
            .await
            .expect("custom import");
        assert_eq!(att.name, "notes.md");
        assert_eq!(att.r#type, "text/markdown");
        assert_eq!(att.size, 11);

        ctx.service.close().await;
    }
}
