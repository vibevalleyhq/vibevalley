//! The bridge between VibeValley's hosted TSX views and the in-process server.
//!
//! [`Server`] is the Rust-facing contract approved on 2026-11-13 (proposed by
//! the server agent). It is defined here until the server's own API crate
//! exists; that crate will own it and this one will re-export it. Payloads,
//! frames and events are VibeValley's protocol JSON; [`Envelope`] and
//! [`LiveEvent`] are `vibevalley-protocol`'s.
//!
//! [`Hub`] serves one server to any number of views through an [`Outlet`]
//! (the app wires outlets to nsh's `HostChannel`). [`fake::FakeServer`]
//! serves fixture state and canned answers for building views without the
//! server.
//!
//! Wire, as `ui/bridge.ts` sees it (event names are `HostChannel` events,
//! actions are `host.post("action", ...)`):
//!
//! | TSX | action | events back |
//! | --- | --- | --- |
//! | `call(op, payload)` | `{ type: "call", id, op, payload }` | `reply:<id>` = the `Envelope` |
//! | `frame("state")` | `{ type: "watch", topic: "state" }` | `frame:state` = `{ rev, data: StateFrame }` |
//! | `frame("live")`, `onLive(fn)` | `{ type: "watch", topic: "live" }` | `frame:live` = `{ rev, data: LiveEvent }`, one per event |
//! | `subscribe(name, payload, on, ended)` | `{ type: "subscribe", id, name, payload }` | `sub:<id>` = `{ event }` per event, then once `{ end: null \| Envelope }` |
//! | `stop()` of a subscription | `{ type: "unsubscribe", id }` | |

pub mod fake;
mod hub;

pub use crate::transport::api::{ApiError, BizCode, Envelope, LiveEvent, Server, refusal};
pub use hub::{Client, Hub, Outlet};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelopes_are_vibevalleys() {
        assert_eq!(serde_json::to_value(Envelope::void()).unwrap(), json!({ "bizCode": 0, "message": "ok" }));
        assert_eq!(
            serde_json::to_value(refusal(BizCode::RouteNotFound, "no")).unwrap(),
            json!({ "bizCode": 100005, "message": "no" })
        );
    }
}
