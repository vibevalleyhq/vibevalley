//! Binary media transport, separate from JSON RPC. Only local transports may
//! expose uploads; the implementation owns validation and input reservations.
use std::{io::Read, sync::Arc};
use vibevalley_protocol::{ApiError, AttachmentFile, MediaInput};
pub trait MediaInputs: Send + Sync {
    fn upload(&self, id: &str, source: Box<dyn Read + Send>) -> Result<MediaInput, ApiError>;
    fn content(&self, id: &str) -> Result<AttachmentFile, ApiError>;
}
pub type SharedMediaInputs = Arc<dyn MediaInputs>;

/// A streamed speech job's events for the one page that reads them
/// (`GET /api/v1/media/speech/:id/stream`): each a `MediaSpeechEvent`, the
/// stream ending after `done` or `failed`. Dropping the claim (the page gone)
/// cancels the job.
pub trait SpeechStreams: Send + Sync {
    fn claim(&self, id: &str) -> Result<SpeechClaim, ApiError>;
}

pub struct SpeechClaim {
    pub events: flume::Receiver<serde_json::Value>,
    /// Called once when the reader goes away.
    pub gone: Box<dyn FnOnce() + Send>,
}

pub type SharedSpeechStreams = Arc<dyn SpeechStreams>;
