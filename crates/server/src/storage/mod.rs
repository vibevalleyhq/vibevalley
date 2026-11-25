//! Core file and staged media input storage (`Storage`), combining content-addressed
//! attachments ([`AttachmentStorage`]) and temporary staged uploads ([`MediaInputStorage`]).

pub mod artifact;
pub mod attachment;
pub mod media_input;
pub mod validate;

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use vibevalley_protocol::{ApiError, Attachment, AttachmentFile, AttachmentImportPathInput, AttachmentUpload, MediaInput, MediaInputRequest, Preview};

pub use artifact::ArtifactStorage;
pub use attachment::{ATTACHMENT_MAX, AttachmentStorage};
pub use media_input::MediaInputStorage;
pub use validate::{AudioFacts, audio_facts};

use crate::context::Context;
use crate::service::Tx;

/// Unified server file storage: content-addressed attachments, staged media inputs, and artifact directories.
pub struct Storage {
    pub attachment: Arc<AttachmentStorage>,
    pub media_input: Arc<MediaInputStorage>,
    pub artifact: Arc<ArtifactStorage>,
}

impl Storage {
    /// Opens attachment CAS, staged media input storage, and artifact directory storage under `home`, awaiting the
    /// initial staged-input recovery sweep and starting the periodic sweeper on `ctx.task`.
    pub async fn open_async(home: &Path, ctx: Arc<Context>) -> Result<Arc<Self>, ApiError> {
        let attachment = AttachmentStorage::open(home, ctx.clone());
        let media_input = MediaInputStorage::open_async(home, ctx.clone(), attachment.clone()).await?;
        let artifact = ArtifactStorage::open(home, ctx);
        Ok(Arc::new(Self {
            attachment,
            media_input,
            artifact,
        }))
    }

    /// Stops the staged media input sweeper cleanly.
    pub async fn close_async(&self) {
        self.media_input.close_async().await;
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
