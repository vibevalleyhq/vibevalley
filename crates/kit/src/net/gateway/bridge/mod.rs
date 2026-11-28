//! Domain-agnostic host/view bridge wire frames, outlet port, and in-memory
//! recording outlet for unit tests.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Incoming bridge action posted from a hosted UI view to the host bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BridgeAction {
    Call {
        id: String,
        op: String,
        #[serde(default)]
        payload: Value,
    },
    Watch {
        topic: String,
    },
    Unwatch {
        topic: String,
    },
    Subscribe {
        id: String,
        name: String,
        #[serde(default)]
        payload: Value,
    },
    Unsubscribe {
        id: String,
    },
}

/// Revision-tagged snapshot frame emitted for watched bridge topics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeFrame<T = Value> {
    pub rev: i64,
    pub data: T,
}

/// Outbound bridge event emitted over a [`BridgeOutlet`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeEvent {
    pub channel: String,
    pub payload: Value,
}

impl BridgeEvent {
    pub fn reply(id: &str, envelope: Value) -> Self {
        Self {
            channel: format!("reply:{id}"),
            payload: envelope,
        }
    }

    pub fn frame(topic: &str, rev: i64, data: Value) -> Self {
        Self {
            channel: format!("frame:{topic}"),
            payload: json!({ "rev": rev, "data": data }),
        }
    }

    pub fn sub_event(id: &str, event: Value) -> Self {
        Self {
            channel: format!("sub:{id}"),
            payload: json!({ "event": event }),
        }
    }

    pub fn sub_end(id: &str, end: Value) -> Self {
        Self {
            channel: format!("sub:{id}"),
            payload: json!({ "end": end }),
        }
    }
}

/// Host output channel receiving serialized bridge events for a mounted view.
pub trait BridgeOutlet: Send + Sync + 'static {
    fn emit(&self, channel: &str, payload: Value);

    fn emit_event(&self, event: BridgeEvent) {
        self.emit(&event.channel, event.payload);
    }
}

/// In-memory [`BridgeOutlet`] test twin recording every emitted event in order.
#[derive(Default)]
pub struct RecordingOutlet {
    events: Mutex<Vec<BridgeEvent>>,
}

impl RecordingOutlet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn events(&self) -> Vec<BridgeEvent> {
        self.events.lock().clone()
    }

    pub fn take_events(&self) -> Vec<BridgeEvent> {
        std::mem::take(&mut *self.events.lock())
    }
}

impl BridgeOutlet for RecordingOutlet {
    fn emit(&self, channel: &str, payload: Value) {
        self.events.lock().push(BridgeEvent {
            channel: channel.to_string(),
            payload,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_actions_and_recording_outlet_roundtrip() {
        let action: BridgeAction = serde_json::from_value(json!({
            "type": "call",
            "id": "req-1",
            "op": "ping",
            "payload": { "x": 1 }
        }))
        .unwrap();
        assert_eq!(
            action,
            BridgeAction::Call {
                id: "req-1".into(),
                op: "ping".into(),
                payload: json!({ "x": 1 }),
            }
        );

        let outlet = RecordingOutlet::new();
        outlet.emit_event(BridgeEvent::frame("slice:board", 7, json!({ "seq": 7 })));
        outlet.emit_event(BridgeEvent::reply("req-1", json!({ "bizCode": 0 })));
        let events = outlet.take_events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].channel, "frame:slice:board");
        assert_eq!(events[0].payload["rev"], 7);
        assert_eq!(events[1].channel, "reply:req-1");
        assert!(outlet.events().is_empty());
    }
}
