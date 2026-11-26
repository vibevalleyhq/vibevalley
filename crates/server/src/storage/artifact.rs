//! Directory-backed artifact storage (`<home>/artifact/<id>/`) managed by [`Storage`].
//!
//! Each artifact owns a concrete directory containing `manifest.json`,
//! `structure/`, and `asset/`, plus immutable version snapshots under
//! `<home>/artifact_snapshot/<id>/<storage_id>/`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use vibevalley_core::artifact::{
    ArtifactPathZone, FILE_MAX_COUNT, MANIFEST_FILE, STRUCTURE_DIR, canonical_json, default_manifest, extract_artifact_preview, infer_encoding, infer_mime,
    is_text_mime, parse_manifest, preview_frame_asset, serialize_manifest, set_preview_frame_path, starter_directory, type_spec, validate_artifact_path,
    validate_deletable_path, validate_manifest, validate_prefix,
};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, ArtifactCover, ArtifactCoverSetRequest, ArtifactFileContent, ArtifactFileEncoding, ArtifactFileMeta, ArtifactFileWriteItem, ArtifactPreview,
    ArtifactType, BizCode,
};

use crate::context::{Context, internal};

const COVER_META_FILE: &str = ".cover.json";
const PREVIEW_CACHE_FILE: &str = ".preview.json";
const PREVIEW_CACHE_VERSION: u32 = 1;
const COVER_MAX_BYTES: usize = 2 * 1024 * 1024;
const PREVIEW_STRUCTURE_MAX_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCoverMeta {
    file: String,
    mime: String,
    seq: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPreviewCache {
    schema_version: u32,
    seq: i64,
    preview: ArtifactPreview,
}

fn cover_ext_for_mime(mime: &str) -> Option<(&'static str, &'static str)> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some(("image/png", "png")),
        "image/jpeg" | "image/jpg" => Some(("image/jpeg", "jpg")),
        "image/webp" => Some(("image/webp", "webp")),
        _ => None,
    }
}

fn has_valid_image_magic(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => bytes.len() >= 8 && bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/jpeg" => bytes.len() >= 3 && bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    (w > 0 && h > 0).then_some((w, h))
}

fn cover_wire(artifact_id: &str, canonical_path: &Path, meta: &StoredCoverMeta) -> ArtifactCover {
    ArtifactCover {
        path: canonical_path.to_string_lossy().into_owned(),
        url: format!("/api/v1/artifact/{artifact_id}/cover?seq={}", meta.seq),
        mime: meta.mime.clone(),
        seq: meta.seq,
        width: meta.width,
        height: meta.height,
        updated_at: meta.updated_at,
    }
}

fn is_safe_cover_filename(file: &str) -> bool {
    !file.is_empty() && !file.contains('/') && !file.contains('\\') && file.starts_with(".cover-")
}

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
            if name_str.starts_with('.') {
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
    preview_cache: RwLock<HashMap<String, (i64, ArtifactPreview)>>,
    cover_cache: RwLock<HashMap<String, Option<ArtifactCover>>>,
}

/// Initialized artifact directory metadata and raw file map returned by [`ArtifactStorage::init_directory_async`].
pub type InitDirectoryResult = (Vec<ArtifactFileMeta>, BTreeMap<String, Vec<u8>>);

impl ArtifactStorage {
    pub fn open(home: &Path, ctx: Arc<Context>) -> Arc<Self> {
        Arc::new(Self {
            live_root: home.join("artifact"),
            snapshot_root: home.join("artifact_snapshot"),
            ctx,
            preview_cache: RwLock::new(HashMap::new()),
            cover_cache: RwLock::new(HashMap::new()),
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
        self.preview_cache.write().remove(artifact_id);
        self.cover_cache.write().remove(artifact_id);
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

    async fn resolve_frame_path_async(&self, root: &Path, preview: &mut ArtifactPreview) {
        let resolved = match preview_frame_asset(preview) {
            Some(rel) if validate_artifact_path(rel).ok() == Some(ArtifactPathZone::Asset) => {
                let abs = root.join(rel);
                if tokio::fs::metadata(&abs).await.is_ok_and(|m| m.is_file()) {
                    // Canonicalize so symlinked VIBEVALLEY_HOME matches nsh's canonical fs.read grants.
                    let canonical = tokio::fs::canonicalize(&abs).await.unwrap_or(abs);
                    Some(canonical.to_string_lossy().into_owned())
                } else {
                    None
                }
            }
            _ => None,
        };
        set_preview_frame_path(preview, resolved);
    }

    /// Extracts (or serves from cache) a lightweight structured [`ArtifactPreview`] keyed by `(artifact_id, seq)`.
    pub async fn preview_async(&self, artifact_id: &str, artifact_type: ArtifactType, seq: i64) -> ArtifactPreview {
        if let Some((cached_seq, cached)) = self.preview_cache.read().get(artifact_id)
            && *cached_seq == seq
        {
            return cached.clone();
        }

        let root = self.artifact_dir(artifact_id);
        let cache_file = root.join(PREVIEW_CACHE_FILE);
        if let Ok(raw) = tokio::fs::read_to_string(&cache_file).await
            && let Ok(mut disk) = serde_json::from_str::<StoredPreviewCache>(&raw)
            && disk.schema_version == PREVIEW_CACHE_VERSION
            && disk.seq == seq
        {
            self.resolve_frame_path_async(&root, &mut disk.preview).await;
            self.preview_cache.write().insert(artifact_id.to_owned(), (seq, disk.preview.clone()));
            return disk.preview;
        }

        let mut files = BTreeMap::new();
        if let Ok(paths) = collect_relative_files_async(&root).await {
            for (rel, abs) in paths {
                if rel.starts_with("structure/") {
                    let within_cap = tokio::fs::metadata(&abs)
                        .await
                        .is_ok_and(|m| m.is_file() && m.len() <= PREVIEW_STRUCTURE_MAX_BYTES);
                    if within_cap && let Ok(bytes) = tokio::fs::read(&abs).await {
                        files.insert(rel, bytes);
                    }
                } else if rel.starts_with("asset/") {
                    // Preview extraction only checks relative asset existence, never reads media bytes.
                    files.insert(rel, Vec::new());
                }
            }
        }

        let mut preview = extract_artifact_preview(artifact_type, &files);
        self.resolve_frame_path_async(&root, &mut preview).await;

        if tokio::fs::try_exists(&root).await.unwrap_or(false)
            && let Ok(encoded) = serde_json::to_vec(&StoredPreviewCache {
                schema_version: PREVIEW_CACHE_VERSION,
                seq,
                preview: preview.clone(),
            })
        {
            let _ = write_atomic_async(&cache_file, &encoded).await;
        }

        self.preview_cache.write().insert(artifact_id.to_owned(), (seq, preview.clone()));
        preview
    }

    async fn read_cover_from_disk_async(&self, artifact_id: &str) -> Option<ArtifactCover> {
        let root = self.artifact_dir(artifact_id);
        let raw = tokio::fs::read_to_string(root.join(COVER_META_FILE)).await.ok()?;
        let meta = serde_json::from_str::<StoredCoverMeta>(&raw).ok()?;
        if !is_safe_cover_filename(&meta.file) {
            return None;
        }
        let abs = root.join(&meta.file);
        if !tokio::fs::metadata(&abs).await.is_ok_and(|m| m.is_file()) {
            return None;
        }
        let canonical = tokio::fs::canonicalize(&abs).await.unwrap_or(abs);
        Some(cover_wire(artifact_id, &canonical, &meta))
    }

    /// Reads the derived auto-cover metadata for `artifact_id` if present (cached in memory).
    pub async fn cover_async(&self, artifact_id: &str) -> Option<ArtifactCover> {
        if let Some(cached) = self.cover_cache.read().get(artifact_id) {
            return cached.clone();
        }
        let loaded = self.read_cover_from_disk_async(artifact_id).await;
        self.cover_cache.write().insert(artifact_id.to_owned(), loaded.clone());
        loaded
    }

    /// Stores a derived auto-captured cover image under `<home>/artifact/<id>/.cover-<seq>-<ts>.<ext>` + `.cover.json`
    /// without touching `manifest.json`, `structure/`, `asset/`, CRDT, or version snapshots.
    pub async fn write_cover_async(&self, artifact_id: &str, req: &ArtifactCoverSetRequest) -> Result<ArtifactCover, ApiError> {
        let Some((canonical_mime, ext)) = cover_ext_for_mime(&req.mime) else {
            return Err(refused("cover mime must be image/png, image/jpeg, or image/webp"));
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(req.data.trim())
            .map_err(|e| refused(format!("cover: invalid base64 content: {e}")))?;
        if bytes.is_empty() {
            return Err(refused("cover image data is empty"));
        }
        if bytes.len() > COVER_MAX_BYTES {
            return Err(refused(format!("cover exceeds {COVER_MAX_BYTES} byte limit")));
        }
        if !has_valid_image_magic(canonical_mime, &bytes) {
            return Err(refused(format!("cover bytes do not match {canonical_mime}")));
        }

        if let Some(existing) = self.cover_async(artifact_id).await
            && existing.seq > req.seq
        {
            return Ok(existing);
        }

        let root = self.artifact_dir(artifact_id);
        tokio::fs::create_dir_all(&root).await.map_err(internal)?;
        let updated_at = self.ctx.now();
        let (inferred_w, inferred_h) = if canonical_mime == "image/png" {
            png_dimensions(&bytes).map_or((None, None), |(w, h)| (Some(w), Some(h)))
        } else {
            (None, None)
        };
        let width = req.width.or(inferred_w);
        let height = req.height.or(inferred_h);

        let filename = format!(".cover-{}-{updated_at}.{ext}", req.seq);
        let meta = StoredCoverMeta {
            file: filename.clone(),
            mime: canonical_mime.to_owned(),
            seq: req.seq,
            width,
            height,
            updated_at,
        };
        let meta_bytes = serde_json::to_vec(&meta).map_err(internal)?;

        let cover_abs = root.join(&filename);
        write_atomic_async(&cover_abs, &bytes).await.map_err(internal)?;
        write_atomic_async(&root.join(COVER_META_FILE), &meta_bytes).await.map_err(internal)?;

        // Clean up superseded derived cover files so disk stays tidy.
        if let Ok(mut rd) = tokio::fs::read_dir(&root).await {
            while let Ok(Some(entry)) = rd.next_entry().await {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with(".cover") && name_str != filename && name_str != COVER_META_FILE {
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }

        let canonical = tokio::fs::canonicalize(&cover_abs).await.unwrap_or(cover_abs);
        let wire = cover_wire(artifact_id, &canonical, &meta);
        self.cover_cache.write().insert(artifact_id.to_owned(), Some(wire.clone()));
        Ok(wire)
    }
}
