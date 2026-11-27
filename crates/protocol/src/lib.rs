//! VibeValley's wire protocol and home directory conventions.
//! Every wire type serializes to exact camelCase JSON matching `packages/protocol`.

pub mod contract;
pub mod envelope;
mod ext;
pub mod home;
mod native;
pub mod secret;
#[cfg(feature = "ts-gen")]
pub mod typescript;
pub mod vdp;
pub mod wire;

pub use contract::*;
pub use envelope::*;
pub use ext::*;
pub use native::*;
pub use secret::Secret;
pub use vdp::*;
pub use wire::*;
