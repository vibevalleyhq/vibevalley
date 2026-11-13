//! VibeValley's wire protocol (`packages/protocol`)
//! in Rust. Every type serializes to exactly the JSON VibeValley's own code
//! produces: camelCase fields, absent (not null) optional fields, `_tag`,
//! `type`, `kind` and `does` unions, and VibeValley's enum strings.
//!
//! `generated/` is written by `gen/gen.ts` from VibeValley's zod schemas
//! (`gen/run.sh`); `gen/report.txt` lists what it could not map exactly.
//! The envelope and business codes (`endpoint.ts`, not a schema) are
//! hand-written in `envelope`; helpers on the generated types are in `ext`.
//! The golden tests in `tests/` hold all of it against JSON written by
//! VibeValley's code (`gen/golden.ts`).

pub mod envelope;
mod ext;
pub mod generated;
mod native;
pub mod wire;

pub use envelope::*;
pub use ext::*;
pub use generated::*;
pub use native::*;
pub use wire::*;
