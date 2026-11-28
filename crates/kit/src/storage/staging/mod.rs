//! Bounded streaming staging area for uploads (`.tmp` files + streaming SHA-256 + startup cleanup).

pub mod upload;

pub use upload::{StageError, StageLimits, StagedFile, StagingArea};
