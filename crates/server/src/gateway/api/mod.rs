//! The in-process server contract. `gateway::bridge` and `gateway::http`
//! serve views and external clients through [`Server`] and [`GatewayPorts`].
//! Payloads, slices, and events are VibeValley's protocol JSON.

pub use crate::context::api::*;
pub use crate::log::{InvokeObserver, SharedInvokeObserver};

mod dispatch;
pub mod media;

pub use dispatch::{BridgeRpc, ClientRpc, Server};
pub(crate) use dispatch::{
    GatewayMeta, decode, dispatch_boundary_async, flush_and_snapshot_json, flush_and_subscribe_slice, invoke_server_op, ok_json, open_subscription_channel,
    slice_snapshot_value, watch_slice_value,
};
