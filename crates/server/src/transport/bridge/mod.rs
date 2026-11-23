//! The bridge between VibeValley's hosted TSX views and the in-process server.
//!
//! [`Hub`] serves one [`Server`] to any number of views through an [`Outlet`]
//! (the app wires outlets to nsh's `HostChannel`). [`fake::FakeServer`]
//! serves fixture slices and canned answers for building views without the
//! server.
//!
//! Wire, as `ui/infra/bridge.ts` sees it (event names are `HostChannel` events,
//! actions are `host.post("action", ...)`):
//!
//! | TSX | action | events back |
//! | --- | --- | --- |
//! | `call(op, payload)` | `{ type: "call", id, op, payload }` | `reply:<id>` = the `Envelope` |
//! | `slice(kind)` | `{ type: "watch", topic: "slice:<kind>" }` | `frame:slice:<kind>` = `{ rev, data: <Slice> }` |
//! | `onLive(fn)` | `{ type: "watch", topic: "live" }` | `frame:live` = `{ rev, data: LiveEvent }`, one per event |
//! | `subscribe(name, payload, on, ended)` | `{ type: "subscribe", id, name, payload }` | `sub:<id>` = `{ event }` per event, then once `{ end: null \| Envelope }` |
//! | `stop()` of a subscription | `{ type: "unsubscribe", id }` | |

pub mod fake;
mod hub;

pub use crate::transport::api::{
    ApiError, BizCode, Caller, CallerContext, CallerPrincipal, ClientIdentity, ClientKind, Envelope, LiveEvent, LiveVoiceLine, LiveVoicePort, Server,
    SharedLiveVoice, SliceKind, refusal,
};
pub use hub::{Client, ClientSnapshot, Hub, Outlet};

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
