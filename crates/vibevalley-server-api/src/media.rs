//! Binary media transport, separate from JSON RPC. Only local transports may
//! expose uploads; the implementation owns validation and input reservations.
use std::{io::Read, sync::Arc};
use vibevalley_protocol::{ApiError, AttachmentFile, MediaInput};
pub trait MediaInputs: Send + Sync {
    fn upload(&self, id: &str, source: Box<dyn Read + Send>) -> Result<MediaInput, ApiError>;
    fn content(&self, id: &str) -> Result<AttachmentFile, ApiError>;
}
pub type SharedMediaInputs = Arc<dyn MediaInputs>;
