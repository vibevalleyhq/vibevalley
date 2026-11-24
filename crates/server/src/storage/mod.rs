//! Core file and staged media input storage (`Storage`), combining content-addressed
//! attachments ([`AttachmentStorage`]) and temporary staged uploads ([`MediaInputStorage`]).

pub mod attachment;
pub mod media_input;
pub mod validate;

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use vibevalley_protocol::{
    ApiError, Attachment, AttachmentFile, AttachmentImportPathInput, AttachmentUpload, BizCode, EndpointId, MediaInput, MediaInputRequest, Op, Preview, ops,
};
use vibevalley_protocol::{NativeEndpointId, native_ops};

pub use attachment::{ATTACHMENT_MAX, AttachmentStorage};
pub use media_input::MediaInputStorage;
pub use validate::{AudioFacts, audio_facts};

use crate::context::Context;
use crate::db::Tx;

/// Unified server file storage: content-addressed attachments and staged media inputs.
pub struct Storage {
    pub attachment: Arc<AttachmentStorage>,
    pub media_input: Arc<MediaInputStorage>,
}

impl Storage {
    /// Opens attachment CAS and staged media input storage synchronously under `home`,
    /// scheduling the initial staged-input recovery and periodic sweeper on `ctx.task`.
    pub fn open(home: &Path, ctx: Arc<Context>) -> Arc<Self> {
        let attachment = AttachmentStorage::open(home, ctx.clone());
        let media_input = MediaInputStorage::open(home, ctx, attachment.clone());
        Arc::new(Self { attachment, media_input })
    }

    /// Opens attachment CAS and staged media input storage under `home`, awaiting the
    /// initial staged-input recovery sweep and starting the periodic sweeper on `ctx.task`.
    pub async fn open_async(home: &Path, ctx: Arc<Context>) -> Result<Arc<Self>, ApiError> {
        let attachment = AttachmentStorage::open(home, ctx.clone());
        let media_input = MediaInputStorage::open_async(home, ctx, attachment.clone()).await?;
        Ok(Arc::new(Self { attachment, media_input }))
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

    /// Dispatches attachment and media-input protocol endpoints for `router.rs`.
    pub(crate) async fn dispatch_endpoint_async(&self, id: EndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            EndpointId::AttachmentCreate => {
                let req: <ops::AttachmentCreate as Op>::Input = decode(payload)?;
                ok_json(self.attachment.attach_async(req).await?)
            }
            EndpointId::AttachmentImportPath => {
                let req: <ops::AttachmentImportPath as Op>::Input = decode(payload)?;
                ok_json(self.attachment.import_path_async(req).await?)
            }
            EndpointId::MediaInputCreate => {
                let req: <ops::MediaInputCreate as Op>::Input = decode(payload)?;
                ok_json(self.media_input.create_async(&req).await?)
            }
            EndpointId::MediaInputAdopt => {
                let req: <ops::MediaInputAdopt as Op>::Input = decode(payload)?;
                ok_json(self.media_input.adopt_async(&req.attachment).await?)
            }
            EndpointId::MediaInputGet => {
                let req: <ops::MediaInputGet as Op>::Input = decode(payload)?;
                ok_json(self.media_input.get_async(&req.id).await?)
            }
            EndpointId::MediaInputList => ok_json(self.media_input.list_async().await?),
            EndpointId::MediaInputDelete => {
                let req: <ops::MediaInputDelete as Op>::Input = decode(payload)?;
                self.media_input.delete_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::MediaInputPreviewDelete => {
                let req: <ops::MediaInputPreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.media_input.preview_delete_async(&req.id).await?)
            }
            other => Err(ApiError::new(
                BizCode::RouteNotFound,
                format!("storage does not handle endpoint {}", other.as_op()),
            )),
        }
    }

    /// Dispatches native attachment and media-input endpoints for `router.rs`.
    pub(crate) async fn dispatch_native_async(&self, id: NativeEndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            NativeEndpointId::AttachmentFile => {
                let req: <native_ops::AttachmentFile as Op>::Input = decode(payload)?;
                ok_json(self.attachment.file_async(&req.id).await?)
            }
            NativeEndpointId::MediaInputFile => {
                let req: <native_ops::MediaInputFile as Op>::Input = decode(payload)?;
                ok_json(self.media_input.content_async(&req.id).await?)
            }
            NativeEndpointId::MediaInputUploadFile => {
                let req: <native_ops::MediaInputUploadFile as Op>::Input = decode(payload)?;
                ok_json(self.media_input.upload_file_async(&req.id, PathBuf::from(req.path)).await?)
            }
            other => Err(ApiError::new(
                BizCode::RouteNotFound,
                format!("storage does not handle native endpoint {}", other.op()),
            )),
        }
    }
}

impl crate::gateway::api::media::MediaInputs for Storage {
    fn upload_async(self: Arc<Self>, id: String, source: Box<dyn Read + Send>) -> crate::BoxFuture<'static, Result<MediaInput, ApiError>> {
        self.media_input.clone().upload_async(id, source)
    }

    fn content_async(self: Arc<Self>, id: String) -> crate::BoxFuture<'static, Result<AttachmentFile, ApiError>> {
        self.media_input.clone().content_async(id)
    }
}

fn ok_json<T: Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
}

fn decode<T: DeserializeOwned>(payload: Value) -> Result<T, ApiError> {
    serde_path_to_error::deserialize(payload).map_err(|e| {
        let path = e.path().to_string();
        let problem = e.into_inner().to_string();
        let message = if path == "." || path.is_empty() {
            problem
        } else {
            format!("{path}: {problem}")
        };
        ApiError::new(BizCode::InvalidInput, message)
    })
}
