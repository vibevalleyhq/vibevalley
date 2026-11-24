//! Directory-backed artifact storage (`<home>/artifact/<id>/`) managed by [`Storage`].
//!
//! Each artifact owns a concrete directory containing `manifest.json`,
//! `structure/`, and `asset/`, plus immutable version snapshots under
//! `<home>/artifact_snapshot/<id>/<storage_id>/`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use vibevalley_core::artifact::{
    ArtifactPathZone, FILE_MAX_COUNT, MANIFEST_FILE, STRUCTURE_DIR, canonical_json, default_manifest, infer_encoding, infer_mime, is_text_mime, parse_manifest,
    serialize_manifest, starter_directory, type_spec, validate_artifact_path, validate_deletable_path, validate_manifest, validate_prefix,
};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, ArtifactFileContent, ArtifactFileEncoding, ArtifactFileMeta, ArtifactFileWriteItem, ArtifactType, BizCode};

use crate::context::{Context, internal};

fn refused(text: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::ArtifactRefused, text.into())
}

fn missing_artifact_or_file(title: &str, path: &str) -> ApiError {
    ApiError::new(
        BizCode::ArtifactNotFound,
        t("server.artifact.file.missing", &[("title", title.into()), ("path", path.into())]),
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn mtime_ms(modified: std::io::Result<std::time::SystemTime>, fallback: i64) -> i64 {
    modified
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(fallback, |d| i64::try_from(d.as_millis()).unwrap_or(fallback))
}

async fn write_atomic_async(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| std::io::Error::other("missing parent"))?;
    tokio::fs::create_dir_all(parent).await?;
    let tmp = parent.join(format!(".tmp-{}", uuid::Uuid::now_v7()));
    {
        let mut f = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).await?;
        f.write_all(bytes).await?;
        f.sync_all().await?;
    }
    if let Err(err) = tokio::fs::rename(&tmp, target).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(err);
    }
    Ok(())
}

async fn collect_relative_files_async(root: &Path) -> std::io::Result<BTreeMap<String, PathBuf>> {
    let mut out = BTreeMap::new();
    if !tokio::fs::try_exists(root).await? {
        return Ok(out);
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&dir).await?;
        while let Some(entry) = rd.next_entry().await? {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with(".tmp-") || name_str == ".versions" {
                continue;
            }
            let path = entry.path();
            let ft = entry.file_type().await?;
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                let rel = path.strip_prefix(root).map_err(std::io::Error::other)?.to_string_lossy().replace('\\', "/");
                if validate_artifact_path(&rel).is_ok() {
                    out.insert(rel, path);
                }
            }
        }
    }
    Ok(out)
}

async fn list_dir_files_async(root: &Path, prefix: Option<&str>, fallback_at: i64) -> Result<Vec<ArtifactFileMeta>, ApiError> {
    if !tokio::fs::try_exists(root).await.map_err(internal)? {
        return Ok(Vec::new());
    }
    let paths = collect_relative_files_async(root).await.map_err(internal)?;
    let mut out = Vec::with_capacity(paths.len());
    for (rel, abs) in paths {
        if let Some(pref) = prefix
            && !pref.is_empty()
            && !rel.starts_with(pref)
        {
            continue;
        }
        let bytes = tokio::fs::read(&abs).await.map_err(internal)?;
        let meta = tokio::fs::metadata(&abs).await.map_err(internal)?;
        out.push(ArtifactFileMeta {
            mime: infer_mime(&rel).to_owned(),
            size: bytes.len() as i64,
            hash: sha256_hex(&bytes),
            updated_at: mtime_ms(meta.modified(), fallback_at),
            path: rel,
        });
    }
    Ok(out)
}

fn decode_write_bytes(item: &ArtifactFileWriteItem, zone: ArtifactPathZone) -> Result<Vec<u8>, ApiError> {
    let encoding = item.encoding.unwrap_or_else(|| infer_encoding(&item.path));
    let bytes = match encoding {
        ArtifactFileEncoding::Utf8 => item.content.as_bytes().to_vec(),
        ArtifactFileEncoding::Base64 => base64::engine::general_purpose::STANDARD
            .decode(item.content.trim())
            .map_err(|e| refused(format!("{}: invalid base64 content: {e}", item.path)))?,
    };
    let max_bytes = zone.max_bytes();
    if bytes.len() > max_bytes {
        return Err(refused(format!("{} exceeds {max_bytes} byte limit", item.path)));
    }
    if item.path.ends_with(".json") || zone == ArtifactPathZone::Manifest {
        let text = std::str::from_utf8(&bytes).map_err(|e| refused(format!("{}: invalid UTF-8 JSON: {e}", item.path)))?;
        canonical_json(text).map_err(|e| refused(format!("{}: invalid JSON: {e}", item.path)))?;
    }
    Ok(bytes)
}

async fn refresh_manifest_files_async(root: &Path, artifact_id: &str, artifact_type: ArtifactType, title: &str) -> Result<(), ApiError> {
    let manifest_abs = root.join(MANIFEST_FILE);
    let mut manifest = if tokio::fs::try_exists(&manifest_abs).await.map_err(internal)? {
        let raw = tokio::fs::read_to_string(&manifest_abs).await.map_err(internal)?;
        parse_manifest(&raw).unwrap_or_else(|_| default_manifest(artifact_id, artifact_type, title))
    } else {
        default_manifest(artifact_id, artifact_type, title)
    };
    manifest.id = artifact_id.to_owned();
    manifest.artifact_type = artifact_type;
    manifest.title = title.to_owned();
    if manifest.entry.trim().is_empty() {
        manifest.entry = type_spec(artifact_type).entry_path.to_owned();
    }
    let files_map = collect_relative_files_async(root).await.map_err(internal)?;
    manifest.files = files_map.into_keys().filter(|p| p != MANIFEST_FILE).collect();
    let encoded = serialize_manifest(&manifest).map_err(refused)?;
    write_atomic_async(&manifest_abs, encoded.as_bytes()).await.map_err(internal)?;
    Ok(())
}

/// Manages `<home>/artifact/<id>/` directories and immutable `<home>/artifact_snapshot/<id>/<storage_id>/` copies.
pub struct ArtifactStorage {
    live_root: PathBuf,
    snapshot_root: PathBuf,
    ctx: Arc<Context>,
}

/// Initialized artifact directory metadata and raw file map returned by [`ArtifactStorage::init_directory_async`].
pub type InitDirectoryResult = (Vec<ArtifactFileMeta>, BTreeMap<String, Vec<u8>>);

impl ArtifactStorage {
    pub fn open(home: &Path, ctx: Arc<Context>) -> Arc<Self> {
        Arc::new(Self {
            live_root: home.join("artifact"),
            snapshot_root: home.join("artifact_snapshot"),
            ctx,
        })
    }

    pub fn artifact_dir(&self, id: &str) -> PathBuf {
        self.live_root.join(id)
    }

    pub fn snapshot_dir(&self, artifact_id: &str, storage_id: &str) -> PathBuf {
        self.snapshot_root.join(artifact_id).join(storage_id)
    }

    /// Initializes `<home>/artifact/<id>/` with starter files for `artifact_type` plus any caller overrides.
    pub async fn init_directory_async(
        &self,
        id: &str,
        artifact_type: ArtifactType,
        title: &str,
        entry_override: Option<&str>,
        initial_files: &[ArtifactFileWriteItem],
        design_system_id: Option<&str>,
    ) -> Result<InitDirectoryResult, ApiError> {
        let root = self.artifact_dir(id);
        let now_at = self.ctx.now();
        let mut starter = starter_directory(id, artifact_type, title);
        starter.manifest.design_system_id = design_system_id.map(str::to_owned);
        for rel_dir in &starter.dirs {
            tokio::fs::create_dir_all(root.join(rel_dir)).await.map_err(internal)?;
        }
        for f in &starter.files {
            write_atomic_async(&root.join(&f.path), f.content.as_bytes()).await.map_err(internal)?;
        }
        if let Some(content) = entry_override {
            let entry_path = type_spec(artifact_type).entry_path;
            let item = ArtifactFileWriteItem {
                path: entry_path.to_owned(),
                content: content.to_owned(),
                encoding: Some(ArtifactFileEncoding::Utf8),
                mime: None,
                expected_hash: None,
            };
            let zone = validate_artifact_path(&item.path).map_err(refused)?;
            let bytes = decode_write_bytes(&item, zone)?;
            write_atomic_async(&root.join(&item.path), &bytes).await.map_err(internal)?;
        }
        for item in initial_files {
            let zone = validate_artifact_path(&item.path).map_err(refused)?;
            let bytes = decode_write_bytes(item, zone)?;
            if zone == ArtifactPathZone::Manifest {
                let text = std::str::from_utf8(&bytes).map_err(|e| refused(format!("manifest.json: {e}")))?;
                let parsed = parse_manifest(text).map_err(refused)?;
                validate_manifest(&parsed).map_err(refused)?;
            }
            write_atomic_async(&root.join(&item.path), &bytes).await.map_err(internal)?;
        }
        if !tokio::fs::try_exists(root.join(MANIFEST_FILE)).await.map_err(internal)? {
            let encoded = serialize_manifest(&starter.manifest).map_err(refused)?;
            write_atomic_async(&root.join(MANIFEST_FILE), encoded.as_bytes()).await.map_err(internal)?;
        }
        refresh_manifest_files_async(&root, id, artifact_type, title).await?;

        let metas = list_dir_files_async(&root, None, now_at).await?;
        if metas.len() > FILE_MAX_COUNT {
            return Err(refused(format!("artifact exceeds {FILE_MAX_COUNT} file limit")));
        }
        let mut raw = BTreeMap::new();
        for m in &metas {
            raw.insert(m.path.clone(), tokio::fs::read(root.join(&m.path)).await.map_err(internal)?);
        }
        Ok((metas, raw))
    }

    /// Lists all files inside `<home>/artifact/<id>/` matching optional `prefix`.
    pub async fn list_files_async(&self, id: &str, prefix: Option<&str>) -> Result<Vec<ArtifactFileMeta>, ApiError> {
        let prefix_owned = prefix.unwrap_or("").trim().to_owned();
        if !prefix_owned.is_empty() {
            validate_prefix(&prefix_owned).map_err(refused)?;
        }
        let root = self.artifact_dir(id);
        let now_at = self.ctx.now();
        list_dir_files_async(&root, (!prefix_owned.is_empty()).then_some(prefix_owned.as_str()), now_at).await
    }

    /// Reads one file from live directory or from immutable version snapshot `storage_id`.
    pub async fn read_file_async(&self, artifact_id: &str, title: &str, path: &str, storage_id: Option<&str>) -> Result<ArtifactFileContent, ApiError> {
        validate_artifact_path(path).map_err(refused)?;
        let root = match storage_id {
            Some(sid) => self.snapshot_dir(artifact_id, sid),
            None => self.artifact_dir(artifact_id),
        };
        let now_at = self.ctx.now();
        let abs = root.join(path);
        let Ok(meta) = tokio::fs::metadata(&abs).await else {
            return Err(missing_artifact_or_file(title, path));
        };
        if !meta.is_file() {
            return Err(missing_artifact_or_file(title, path));
        }
        let bytes = tokio::fs::read(&abs).await.map_err(internal)?;
        let mime = infer_mime(path).to_owned();
        let hash = sha256_hex(&bytes);
        let (encoding, content) = if is_text_mime(&mime) {
            match String::from_utf8(bytes) {
                Ok(text) => (ArtifactFileEncoding::Utf8, text),
                Err(e) => (ArtifactFileEncoding::Base64, base64::engine::general_purpose::STANDARD.encode(e.into_bytes())),
            }
        } else {
            (ArtifactFileEncoding::Base64, base64::engine::general_purpose::STANDARD.encode(&bytes))
        };
        Ok(ArtifactFileContent {
            artifact_id: artifact_id.to_owned(),
            path: path.to_owned(),
            mime,
            encoding,
            size: meta.len() as i64,
            content,
            hash,
            updated_at: mtime_ms(meta.modified(), now_at),
        })
    }

    /// Reads every file from either the live directory or an immutable snapshot as `(path -> bytes)`.
    pub async fn read_all_raw_async(&self, artifact_id: &str, storage_id: Option<&str>) -> Result<BTreeMap<String, Vec<u8>>, ApiError> {
        let root = match storage_id {
            Some(sid) => self.snapshot_dir(artifact_id, sid),
            None => self.artifact_dir(artifact_id),
        };
        if !tokio::fs::try_exists(&root).await.map_err(internal)? {
            return Ok(BTreeMap::new());
        }
        let paths = collect_relative_files_async(&root).await.map_err(internal)?;
        let mut out = BTreeMap::new();
        for (rel, abs) in paths {
            out.insert(rel, tokio::fs::read(&abs).await.map_err(internal)?);
        }
        Ok(out)
    }

    /// Reads all files as [`ArtifactFileContent`] (used for directory summary and version snapshots).
    pub async fn read_all_contents_async(&self, artifact_id: &str, title: &str, storage_id: Option<&str>) -> Result<Vec<ArtifactFileContent>, ApiError> {
        let metas = match storage_id {
            Some(sid) => list_dir_files_async(&self.snapshot_dir(artifact_id, sid), None, self.ctx.now()).await?,
            None => self.list_files_async(artifact_id, None).await?,
        };
        let mut out = Vec::with_capacity(metas.len());
        for m in metas {
            out.push(self.read_file_async(artifact_id, title, &m.path, storage_id).await?);
        }
        Ok(out)
    }

    /// Validates, checks optimistic `expected_hash`, writes files atomically, and returns updated [`ArtifactFileMeta`].
    pub async fn write_files_async(
        &self,
        artifact_id: &str,
        artifact_type: ArtifactType,
        title: &str,
        items: &[ArtifactFileWriteItem],
    ) -> Result<Vec<ArtifactFileMeta>, ApiError> {
        let root = self.artifact_dir(artifact_id);
        let now_at = self.ctx.now();
        tokio::fs::create_dir_all(root.join(STRUCTURE_DIR)).await.map_err(internal)?;
        let mut decoded: Vec<(String, ArtifactPathZone, Vec<u8>)> = Vec::with_capacity(items.len());
        let existing_map = collect_relative_files_async(&root).await.map_err(internal)?;

        let mut projected_paths: BTreeSet<String> = existing_map.keys().cloned().collect();
        for item in items {
            let zone = validate_artifact_path(&item.path).map_err(refused)?;
            if let Some(expected) = &item.expected_hash {
                let abs = root.join(&item.path);
                let is_file = tokio::fs::metadata(&abs).await.is_ok_and(|m| m.is_file());
                let current = if is_file {
                    sha256_hex(&tokio::fs::read(&abs).await.map_err(internal)?)
                } else {
                    String::new()
                };
                if current != *expected {
                    return Err(refused(format!(
                        "file {} changed concurrently (expected hash {expected}, current {current})",
                        item.path
                    )));
                }
            }
            let bytes = decode_write_bytes(item, zone)?;
            if zone == ArtifactPathZone::Manifest {
                let text = std::str::from_utf8(&bytes).map_err(|e| refused(format!("manifest.json: {e}")))?;
                let parsed = parse_manifest(text).map_err(refused)?;
                validate_manifest(&parsed).map_err(refused)?;
            }
            projected_paths.insert(item.path.clone());
            decoded.push((item.path.clone(), zone, bytes));
        }
        if projected_paths.len() > FILE_MAX_COUNT {
            return Err(refused(format!("artifact exceeds {FILE_MAX_COUNT} file limit")));
        }

        let mut changed = Vec::with_capacity(decoded.len());
        let mut wrote_manifest = false;
        for (rel, zone, bytes) in decoded {
            if zone == ArtifactPathZone::Manifest {
                wrote_manifest = true;
            }
            let abs = root.join(&rel);
            write_atomic_async(&abs, &bytes).await.map_err(internal)?;
            let meta = tokio::fs::metadata(&abs).await.map_err(internal)?;
            changed.push(ArtifactFileMeta {
                mime: infer_mime(&rel).to_owned(),
                size: bytes.len() as i64,
                hash: sha256_hex(&bytes),
                updated_at: mtime_ms(meta.modified(), now_at),
                path: rel,
            });
        }
        if !wrote_manifest {
            refresh_manifest_files_async(&root, artifact_id, artifact_type, title).await?;
        }
        Ok(changed)
    }

    /// Deletes one file under `structure/` or `asset/` (`manifest.json` cannot be deleted).
    pub async fn delete_file_async(&self, artifact_id: &str, artifact_type: ArtifactType, title: &str, path: &str) -> Result<(), ApiError> {
        validate_deletable_path(path).map_err(refused)?;
        let root = self.artifact_dir(artifact_id);
        let abs = root.join(path);
        if !tokio::fs::metadata(&abs).await.is_ok_and(|m| m.is_file()) {
            return Err(missing_artifact_or_file(title, path));
        }
        tokio::fs::remove_file(&abs).await.map_err(internal)?;
        refresh_manifest_files_async(&root, artifact_id, artifact_type, title).await?;
        Ok(())
    }

    /// Updates `title` inside `manifest.json` after `artifact.update`.
    pub async fn sync_manifest_title_async(&self, artifact_id: &str, artifact_type: ArtifactType, title: &str) -> Result<(), ApiError> {
        let root = self.artifact_dir(artifact_id);
        if tokio::fs::try_exists(&root).await.map_err(internal)? {
            refresh_manifest_files_async(&root, artifact_id, artifact_type, title).await?;
        }
        Ok(())
    }

    /// Reconciles live `<home>/artifact/<id>/` to the exact `files` map (atomic file writes + deletes).
    pub async fn materialize_directory_async(
        &self,
        artifact_id: &str,
        artifact_type: ArtifactType,
        title: &str,
        files: &BTreeMap<String, Vec<u8>>,
    ) -> Result<(Vec<ArtifactFileMeta>, Vec<String>), ApiError> {
        let root = self.artifact_dir(artifact_id);
        let now_at = self.ctx.now();
        for rel_dir in type_spec(artifact_type).default_dirs {
            tokio::fs::create_dir_all(root.join(rel_dir)).await.map_err(internal)?;
        }
        let current = collect_relative_files_async(&root).await.map_err(internal)?;
        let mut deleted = Vec::new();
        for old_rel in current.keys() {
            if old_rel != MANIFEST_FILE && !files.contains_key(old_rel) {
                let _ = tokio::fs::remove_file(root.join(old_rel)).await;
                deleted.push(old_rel.clone());
            }
        }
        let mut updated_metas = Vec::new();
        for (rel, bytes) in files {
            let abs = root.join(rel);
            write_atomic_async(&abs, bytes).await.map_err(internal)?;
            let meta = tokio::fs::metadata(&abs).await.map_err(internal)?;
            updated_metas.push(ArtifactFileMeta {
                path: rel.clone(),
                mime: infer_mime(rel).to_owned(),
                size: bytes.len() as i64,
                hash: sha256_hex(bytes),
                updated_at: mtime_ms(meta.modified(), now_at),
            });
        }
        if !files.contains_key(MANIFEST_FILE) {
            refresh_manifest_files_async(&root, artifact_id, artifact_type, title).await?;
        }
        Ok((updated_metas, deleted))
    }

    /// Creates an immutable snapshot under `<home>/artifact_snapshot/<id>/<storage_id>/` and returns `(storage_id, total_bytes)`.
    pub async fn snapshot_version_async(&self, artifact_id: &str) -> Result<(String, i64), ApiError> {
        let src_root = self.artifact_dir(artifact_id);
        let storage_id = uuid::Uuid::now_v7().to_string();
        let dst_root = self.snapshot_dir(artifact_id, &storage_id);
        if !tokio::fs::try_exists(&src_root).await.map_err(internal)? {
            return Err(internal("artifact directory does not exist for snapshotting"));
        }
        let files = collect_relative_files_async(&src_root).await.map_err(internal)?;
        let mut total_bytes: i64 = 0;
        for (rel, abs) in files {
            let bytes = tokio::fs::read(&abs).await.map_err(internal)?;
            total_bytes += bytes.len() as i64;
            write_atomic_async(&dst_root.join(&rel), &bytes).await.map_err(internal)?;
        }
        Ok((storage_id, total_bytes))
    }

    /// Deletes `<home>/artifact/<id>/` and any version snapshots under `<home>/artifact_snapshot/<id>/`.
    pub async fn delete_directory_async(&self, artifact_id: &str) -> Result<(), ApiError> {
        let live = self.artifact_dir(artifact_id);
        let snap = self.snapshot_root.join(artifact_id);
        if tokio::fs::try_exists(&live).await.map_err(internal)? {
            tokio::fs::remove_dir_all(&live).await.map_err(internal)?;
        }
        if tokio::fs::try_exists(&snap).await.map_err(internal)? {
            tokio::fs::remove_dir_all(&snap).await.map_err(internal)?;
        }
        Ok(())
    }
}
