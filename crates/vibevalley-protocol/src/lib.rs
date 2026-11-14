//! VibeValley's wire protocol. Every type serializes to exactly the JSON the
//! views read and write: camelCase fields, absent (not null) optional fields,
//! `_tag`, `type`, `kind` and `does` unions, and VibeValley's enum strings.
//!
//! `contract/` is the source of the shapes and the endpoint table; the
//! TypeScript in `packages/protocol/src/*/shapes.gen.ts` is written from it
//! (`typescript`, `vp run protocol:ts`). The envelope and business codes are
//! in `envelope`; helpers on the contract's types are in `ext`. The golden
//! tests in `tests/` hold the wire shapes against JSON VibeValley's
//! TypeScript wrote before the contract moved here.

pub mod contract;
pub mod envelope;
mod ext;
mod native;
#[cfg(feature = "ts-gen")]
pub mod typescript;
pub mod wire;

pub use contract::*;
pub use envelope::*;
pub use ext::*;
pub use native::*;
pub use wire::*;
