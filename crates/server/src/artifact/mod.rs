//! Unified directory-backed artifact manager, plus media library and media job owners.

mod collab;
pub mod library;
mod manager;
pub mod media;
pub mod types;

pub use library::{AddedBy, Library};
pub use manager::{Maker, Manager};
pub(in crate::artifact) use manager::{artifact_type_of, encode_manifest_title_if_needed, new_id, q, refused};
pub use media::Media;
