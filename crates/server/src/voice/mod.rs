//! `voice`: pure MOSS Live voice call state machine, WebSocket framing, key verification,
//! and ASR dictation transcription.
//!
//! Zero direct dependency on `channel/` or `agent/orchestrator`: cross-domain transcript
//! persistence and orchestrator briefing live in [`crate::orchestration::voice`].

pub mod moss;
pub mod prompt;
mod service;

pub(crate) use service::failed;
pub use service::{MossAsrLine, MossLine, MossToolRequest, Parts, Voice};
