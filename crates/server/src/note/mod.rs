//! Unified directory-backed note manager, Doc/Base engines, media library, and media job owners.

pub mod annotation;
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
pub use media::{Media, MediaAnnouncement};

pub(in crate::note) const NOTE_USER_ORIGIN: &str = "user";

pub(in crate::note) fn is_user_actor(actor: &str) -> bool {
    actor == NOTE_USER_ORIGIN || vibevalley_protocol::ParticipantId::parse(actor).is_some_and(|p| p.is_human())
}
