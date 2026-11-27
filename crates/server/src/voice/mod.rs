//! `voice`: MOSS Live voice calls and ASR dictation.
//!
//! The server never touches audio: the host (the native app, in process)
//! drives live calls and dictation via [`crate::context::api::LiveVoicePort`]
//! and [`Voice::moss_line`]. What the model heard and said is kept in chat
//! through [`Voice::heard_async`] / [`Voice::said_async`]; the orchestrator
//! answers through the MOSS tool and pushes commentary through [`Voice::speak`].
//! The only RPC endpoint is `voice.moss.verify`.

pub mod moss;
pub mod prompt;
mod service;

pub use service::{MossLine, Parts, Voice};
