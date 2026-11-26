//! `voice.*`: MOSS Live voice calls.
//!
//! The server never touches audio: the host (the native app, in process)
//! holds the MOSS Live socket via [`Voice::moss_line`]. What the model heard
//! and said is kept in chat through `voice.call.hear`, `voice.hear`, and
//! `voice.call.say`; the orchestrator answers through the MOSS tool and
//! pushes commentary through [`Voice::speak`].

pub mod moss;
pub mod prompt;
mod service;

pub use service::{MossLine, Parts, Voice};
