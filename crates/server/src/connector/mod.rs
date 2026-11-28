//! Pure external IM protocol adapters (`connector/`): WeChat, Feishu, and QQ
//! login/pairing lifecycle, durable inbox/outbox delivery, and per-app text formatting.
//!
//! Zero direct dependency on `channel/`, `issue/`, or `runtime/`. Cross-domain
//! channel forwarding, personal notification routing (`NotifyRouter`), and
//! quote-reply action execution live in [`crate::orchestration::connector`].

pub mod adapter;
pub(crate) mod bridge;
mod feishu;
mod qq;
pub mod render;
mod service;
mod weixin;

pub use adapter::{ConnectorHost, InboundDispatch, InboundHandled};
pub use service::{Connector, Options, Vendors, app_of};
