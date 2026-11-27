//! The chat (田头): channels, threads and direct channels, numbered
//! messages, members, read cursors, pure audience/loop-guard dispatch policy,
//! and durable pending deliveries (`channel_delivery`) persisted via
//! `ctx.service.channel` with an atomic in-memory [`model::ChatModel`] snapshot.
//!
//! Every message is written with a numbered event (`channel_event`) and its
//! synchronous `DeliveryPolicy` rows in one transaction; once committed,
//! [`Chat::subscribe_events`] and non-blocking [`Chat::dispatches`] notify
//! downstream consumers without blocking the writer.

pub mod dispatch;
mod message;
pub mod model;
pub mod ops;
mod room;
mod service;
mod types;
pub mod words;

pub use model::Inner;
pub use service::Chat;
pub use types::{
    AddressedMessage, CATCH_UP_MAX, ChannelDispatched, ChannelEvent, ChannelMessageEvent, Committed, DeliveryTargetKind, FileAt, HeldBy, Info, KEEP_CHANNELS,
    Made, Meta, Note, NoteRef, Noticing, Picked, Place, Posting, QueuedDelivery, ReadOptions, ReadResult, Reason, Saying, Seat, Speaking, Spoken,
    ThreadSubject, actor_of, line_of, meta_of, meta_text, profile_id, to_message,
};

#[cfg(test)]
mod tests;
