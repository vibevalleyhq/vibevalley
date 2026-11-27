//! Core file and staged media input storage (`Storage`), combining a pluggable
//! [`StorageBackend`] with content-addressed attachments ([`AttachmentStorage`]),
//! temporary staged uploads ([`MediaInputStorage`]), and note directories ([`NoteStorage`]).

pub mod attachment;
pub mod backend;
pub mod media_input;
pub mod note;
pub mod retention;
pub mod validate;

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use vibevalley_protocol::{ApiError, Attachment, AttachmentFile, AttachmentImportPathInput, AttachmentUpload, MediaInput, MediaInputRequest, Preview};

pub use attachment::{ATTACHMENT_MAX, AttachmentStorage};
pub use backend::{LocalFsBackend, MemoryBackend, ObjectMeta, S3Backend, S3Config, StorageBackend, StorageConfig, StorageError, StorageKind, build_backend};
pub use media_input::MediaInputStorage;
pub use note::NoteStorage;
pub use retention::{Housekeeper, OrphanAttachmentCandidate, OrphanAttachmentReport, RetentionPolicy, RetentionReport};
pub use validate::{AudioFacts, audio_facts};

use crate::context::{Context, internal};
use crate::service::Tx;

/// Unified server file storage: pluggable object backend, content-addressed attachments,
/// staged media inputs, note directories, and periodic retention housekeeping.
pub struct Storage {
    pub backend: Arc<dyn StorageBackend>,
    pub attachment: Arc<AttachmentStorage>,
    pub media_input: Arc<MediaInputStorage>,
    pub note: Arc<NoteStorage>,
    pub housekeeper: Arc<Housekeeper>,
}

impl Storage {
    /// Opens attachment CAS, staged media input storage, and note directory storage under `home`
    /// using the default [`LocalFsBackend`], awaiting the initial staged-input recovery sweep and
    /// starting the periodic sweepers on `ctx.task`.
    pub async fn open_async(home: &Path, ctx: Arc<Context>) -> Result<Arc<Self>, ApiError> {
        let backend: Arc<dyn StorageBackend> = Arc::new(LocalFsBackend::new(home));
        Self::open_with_backend_async(home, backend, ctx).await
    }

    /// Opens [`Storage`] using a validated [`StorageConfig`] (`LocalFs`, `S3`, or `Memory`).
    pub async fn open_with_config_async(home: &Path, config: &StorageConfig, ctx: Arc<Context>) -> Result<Arc<Self>, ApiError> {
        let backend = build_backend(config).map_err(internal)?;
        Self::open_with_backend_async(home, backend, ctx).await
    }

    /// Opens [`Storage`] with an explicit pluggable [`StorageBackend`] instance.
    pub async fn open_with_backend_async(home: &Path, backend: Arc<dyn StorageBackend>, ctx: Arc<Context>) -> Result<Arc<Self>, ApiError> {
        Self::open_with_backend_and_policy_async(home, backend, ctx, RetentionPolicy::from_env()).await
    }

    /// Opens [`Storage`] with an explicit pluggable [`StorageBackend`] and [`RetentionPolicy`].
    pub async fn open_with_backend_and_policy_async(
        home: &Path,
        backend: Arc<dyn StorageBackend>,
        ctx: Arc<Context>,
        policy: RetentionPolicy,
    ) -> Result<Arc<Self>, ApiError> {
        let attachment = AttachmentStorage::open_with_backend(home, backend.clone(), ctx.clone());
        let media_input = MediaInputStorage::open_async(home, ctx.clone(), attachment.clone()).await?;
        let note = NoteStorage::open_with_backend(home, backend.clone(), ctx.clone());
        let housekeeper = Housekeeper::open_and_start(home, backend.clone(), attachment.clone(), ctx, policy);
        Ok(Arc::new(Self {
            backend,
            attachment,
            media_input,
            note,
            housekeeper,
        }))
    }

    pub fn backend_kind(&self) -> StorageKind {
        self.backend.kind()
    }

    /// Returns a time-limited presigned GET URL for attachment `id` when supported by the backend.
    pub fn signed_attachment_url(&self, id: &str, expires_secs: u64) -> Option<String> {
        self.attachment.signed_url(id, expires_secs)
    }

    /// Stops the staged media input and retention sweepers cleanly.
    pub async fn close_async(&self) {
        self.housekeeper.close_async().await;
        self.media_input.close_async().await;
    }

    /// Executes one bounded retention cleanup pass across append-only tables and disk artifacts.
    pub async fn run_housekeeping_async(&self) -> Result<RetentionReport, ApiError> {
        self.housekeeper.run_once_async().await
    }

    /// Scans (or reclaims when `dry_run == false`) unreferenced attachments older than the grace window.
    pub async fn gc_orphan_attachments_async(&self, dry_run: bool) -> Result<OrphanAttachmentReport, ApiError> {
        self.housekeeper.gc_orphan_attachments_async(dry_run).await
    }

    pub fn path_of(&self, id: &str) -> PathBuf {
        self.attachment.path_of(id)
    }

    pub async fn attach_async(&self, upload: AttachmentUpload) -> Result<Attachment, ApiError> {
        self.attachment.attach_async(upload).await
    }

    pub async fn import_path_async(&self, input: AttachmentImportPathInput) -> Result<Attachment, ApiError> {
        self.attachment.import_path_async(input).await
    }

    pub async fn keep_async(&self, bytes: Vec<u8>, name: String, kind: String) -> Result<Attachment, ApiError> {
        self.attachment.keep_async(bytes, name, kind).await
    }

    pub async fn by_id_async(&self, id: &str) -> Result<Option<Attachment>, ApiError> {
        self.attachment.by_id_async(id).await
    }

    pub async fn of_async(&self, ids: &[String]) -> Result<Vec<Attachment>, ApiError> {
        self.attachment.of_async(ids).await
    }

    pub async fn file_async(&self, id: &str) -> Result<AttachmentFile, ApiError> {
        self.attachment.file_async(id).await
    }

    pub async fn read_bytes_async(&self, id: &str) -> Result<(String, Vec<u8>), ApiError> {
        self.attachment.read_bytes_async(id).await
    }

    pub async fn read_attachment_bytes(&self, id: &str) -> Result<(String, Vec<u8>), ApiError> {
        self.attachment.read_bytes_async(id).await
    }

    pub async fn get_input_async(&self, id: &str) -> Result<MediaInput, ApiError> {
        self.media_input.get_async(id).await
    }

    pub async fn list_inputs_async(&self) -> Result<Vec<MediaInput>, ApiError> {
        self.media_input.list_async().await
    }

    pub async fn create_input_async(&self, req: &MediaInputRequest) -> Result<MediaInput, ApiError> {
        self.media_input.create_async(req).await
    }

    pub async fn adopt_input_async(&self, attachment_id: &str) -> Result<MediaInput, ApiError> {
        self.media_input.adopt_async(attachment_id).await
    }

    pub async fn delete_input_async(&self, id: &str) -> Result<(), ApiError> {
        self.media_input.delete_async(id).await
    }

    pub async fn preview_delete_input_async(&self, id: &str) -> Result<Preview, ApiError> {
        self.media_input.preview_delete_async(id).await
    }

    pub async fn upload_input_async(&self, id: &str, source: Box<dyn Read + Send>) -> Result<MediaInput, ApiError> {
        self.media_input.upload_async(id, source).await
    }

    pub async fn upload_input_file_async(&self, id: &str, path: PathBuf) -> Result<MediaInput, ApiError> {
        self.media_input.upload_file_async(id, path).await
    }

    pub async fn input_content_async(&self, id: &str) -> Result<AttachmentFile, ApiError> {
        self.media_input.content_async(id).await
    }

    pub async fn sweep_inputs_async(&self) -> Result<(), ApiError> {
        self.media_input.sweep_async().await
    }

    pub(crate) async fn pin_inputs_in_tx(&self, tx: &Tx, ids: &[String], holder: &str) -> Result<(), ApiError> {
        self.media_input.pin_in_tx(tx, ids, holder).await
    }

    pub async fn pin_inputs_async(&self, ids: &[String], holder: &str) -> Result<(), ApiError> {
        self.media_input.pin_async(ids, holder).await
    }

    pub async fn release_input_pins_async(&self, holder: &str) -> Result<(), ApiError> {
        self.media_input.release_async(holder).await
    }
}

impl crate::context::api::media::MediaInputs for Storage {
    fn upload_async(self: Arc<Self>, id: String, source: Box<dyn Read + Send>) -> crate::BoxFuture<'static, Result<MediaInput, ApiError>> {
        self.media_input.clone().upload_async(id, source)
    }

    fn content_async(self: Arc<Self>, id: String) -> crate::BoxFuture<'static, Result<AttachmentFile, ApiError>> {
        self.media_input.clone().content_async(id)
    }
}
