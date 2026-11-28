//! Domain-agnostic single-flight dirty-mask coalescing hub ([`FeedHub`]) and
//! pre-encoded `tokio::sync::watch<Arc<str>>` channels ([`FeedChannel`]).

mod channel;
mod hub;

pub use channel::{FeedChannel, FeedFrame, FeedSubscription};
pub use hub::{FeedHub, FeedKey};
