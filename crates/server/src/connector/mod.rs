//! The chat apps (WeChat, Feishu, QQ): each ties one account of the user's
//! to a channel. What the user says to the bot there is said in the channel
//! as the user's own words; what the farm says for the user there goes out
//! to the app while the user has not read it in the farm.
//!
//! `Connector` is the door. Behind it each app is an `Adapter` (its login,
//! its connection, its sends) under a `Bridge` (the account, the durable
//! inbox and outbox persisted via `ctx.service.connector`, and status updates
//! published via `ctx.live` + `ctx.mark_dirty`).

pub mod adapter;
mod bridge;
pub mod digest;
mod feishu;
pub mod notify;
mod qq;
mod service;
mod weixin;

pub use notify::{NotifyDecision, NotifyOptions, QuietHours, SuppressReason};
pub use service::{Connector, Options, Vendors, app_of};
