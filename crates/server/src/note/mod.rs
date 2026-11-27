//! Unified directory-backed note manager, Doc/Base engines, media library, and media job owners.

pub mod base;
mod collab;
pub mod doc;
pub mod library;
mod manager;
pub mod media;
pub mod types;

pub use library::{AddedBy, Library};
pub use manager::{Maker, Manager};
pub(in crate::note) use manager::{encode_manifest_title_if_needed, new_id, note_type_of, q, refused};
pub use media::Media;
