use super::{Error, Principal, RpcError};
use crate::transport::chord::delta::Op;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub(crate) enum Frame {
    Hello {
        principal: Principal,
    },
    HelloAck {
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    Ping,
    Pong,
    RpcReq {
        id: String,
        method: String,
        #[serde(default)]
        params: Value,
        #[serde(default)]
        timeout_ms: u64,
    },
    RpcRes {
        id: String,
        #[serde(default)]
        result: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    RpcCancel {
        id: String,
    },
    WatchOpen {
        id: String,
        target: String,
        #[serde(default)]
        from_rev: i64,
    },
    WatchPush {
        id: String,
        rev: i64,
        #[serde(default)]
        ops: Vec<Op>,
        #[serde(default)]
        retired: bool,
        #[serde(default)]
        overflow: bool,
    },
    WatchStop {
        id: String,
    },
    WatchEnd {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    Chunk {
        stream_id: String,
        #[serde(default)]
        seq: usize,
        #[serde(default)]
        total: usize,
        #[serde(default, rename = "final")]
        last: bool,
        data: String,
    },
}

#[derive(Clone, Debug, Hash, Eq, PartialEq)]
enum Lane {
    Call(String),
    Subscription(String),
    Publication(String),
}

enum Priority {
    Control,
    Small,
    Bulk,
}

struct Message {
    packets: VecDeque<Vec<u8>>,
    priority: Priority,
    lane: Option<Lane>,
}

#[derive(Default)]
pub(crate) struct Outbox {
    control: VecDeque<Message>,
    small: VecDeque<Message>,
    streams: VecDeque<Message>,
    // An update cannot overtake a chunked snapshot for the same watch.
    waiting: HashMap<Lane, VecDeque<Message>>,
    turn: bool,
    next_stream: u64,
}

impl Outbox {
    pub fn push(&mut self, frame: Frame, max_frame: usize, max_message: usize) -> Result<(), Error> {
        let bytes = serde_json::to_vec(&frame)?;
        if bytes.len() > max_message {
            return Err(Error::TooLarge);
        }
        let lane = match &frame {
            Frame::RpcReq { id, .. } | Frame::RpcCancel { id } => Some(Lane::Call(id.clone())),
            Frame::WatchOpen { id, .. } | Frame::WatchStop { id } => Some(Lane::Subscription(id.clone())),
            Frame::WatchPush { id, .. } | Frame::WatchEnd { id, .. } => Some(Lane::Publication(id.clone())),
            _ => None,
        };
        let (priority, packets) = if bytes.len() <= max_frame {
            let priority = match frame {
                Frame::Ping | Frame::Pong | Frame::Hello { .. } | Frame::HelloAck { .. } | Frame::RpcCancel { .. } | Frame::WatchStop { .. } => {
                    Priority::Control
                }
                _ => Priority::Small,
            };
            (priority, VecDeque::from([bytes]))
        } else {
            self.next_stream += 1;
            let stream_id = format!("s-{}", self.next_stream);
            let size = (max_frame.max(512) - 256) * 3 / 4;
            let chunks = bytes.chunks(size);
            let total = chunks.len();
            let mut packets = VecDeque::with_capacity(total);
            for (seq, data) in chunks.enumerate() {
                let frame = Frame::Chunk {
                    stream_id: stream_id.clone(),
                    seq,
                    total,
                    last: seq + 1 == total,
                    data: STANDARD.encode(data),
                };
                packets.push_back(serde_json::to_vec(&frame)?);
            }
            (Priority::Bulk, packets)
        };
        let message = Message {
            priority,
            packets,
            lane: lane.clone(),
        };
        if let Some(lane) = lane {
            use std::collections::hash_map::Entry;
            match self.waiting.entry(lane) {
                Entry::Occupied(mut e) => {
                    e.get_mut().push_back(message);
                    return Ok(());
                }
                Entry::Vacant(e) => {
                    e.insert(VecDeque::new());
                }
            }
        }
        self.enqueue(message);
        Ok(())
    }

    fn enqueue(&mut self, message: Message) {
        match message.priority {
            Priority::Control => self.control.push_back(message),
            Priority::Small => self.small.push_back(message),
            Priority::Bulk => self.streams.push_back(message),
        }
    }

    pub fn next(&mut self) -> Option<Vec<u8>> {
        let mut message = self.control.pop_front().or_else(|| {
            self.turn = !self.turn;
            if self.turn
                && let Some(frame) = self.small.pop_front()
            {
                return Some(frame);
            }
            self.streams.pop_front().or_else(|| self.small.pop_front())
        })?;
        let packet = message.packets.pop_front();
        if !message.packets.is_empty() {
            self.streams.push_back(message);
        } else if let Some(lane) = message.lane {
            let pending = self.waiting.get_mut(&lane).expect("active lane registered");
            if let Some(next) = pending.pop_front() {
                self.enqueue(next);
            } else {
                self.waiting.remove(&lane);
            }
        }
        packet
    }
}
#[derive(Default)]
pub(crate) struct Reassembler {
    streams: HashMap<String, (usize, Vec<u8>)>,
    incoming_bytes: usize,
}

impl Reassembler {
    pub fn receive(&mut self, bytes: &[u8], limit: usize) -> Result<Option<Frame>, Error> {
        if bytes.len() > limit {
            return Err(Error::TooLarge);
        }
        let frame: Frame = serde_json::from_slice(bytes)?;
        let Frame::Chunk {
            stream_id, seq, last, data, ..
        } = frame
        else {
            return Ok(Some(frame));
        };
        if stream_id.is_empty() || (!self.streams.contains_key(&stream_id) && self.streams.len() >= 1024) {
            return Err(Error::Protocol("invalid chunk stream".into()));
        }
        let (expected, buf) = self.streams.entry(stream_id.clone()).or_default();
        if seq != *expected {
            return Err(Error::Protocol("out-of-order chunk".into()));
        }
        let data = STANDARD.decode(data).map_err(|e| Error::Protocol(e.to_string()))?;
        if buf.len().saturating_add(data.len()) > limit || self.incoming_bytes.saturating_add(data.len()) > limit.saturating_mul(4) {
            return Err(Error::TooLarge);
        }
        self.incoming_bytes += data.len();
        buf.extend(data);
        *expected += 1;
        if !last {
            return Ok(None);
        }
        let (_, bytes) = self.streams.remove(&stream_id).expect("current stream");
        self.incoming_bytes -= bytes.len();
        let frame = serde_json::from_slice(&bytes)?;
        if matches!(frame, Frame::Chunk { .. }) {
            return Err(Error::Protocol("nested chunk".into()));
        }
        Ok(Some(frame))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn large_watch_frames_preserve_revision_order_but_allow_independent_calls_through() {
        let mut outbox = Outbox::default();
        for f in [
            Frame::WatchPush {
                id: "w".into(),
                rev: 1,
                ops: vec![Op::Replace(vec![], json!("r".repeat(5000)))],
                retired: false,
                overflow: false,
            },
            Frame::WatchPush {
                id: "w".into(),
                rev: 2,
                ops: vec![Op::AppendText(vec![], "ok".into())],
                retired: false,
                overflow: false,
            },
            Frame::RpcRes {
                id: "r".into(),
                result: json!(true),
                error: None,
            },
        ] {
            outbox.push(f, 512, MAX_BYTES).unwrap();
        }
        let mut order = Vec::new();
        let mut assembler = Reassembler::default();
        while let Some(wire) = outbox.next() {
            assert!(wire.len() <= 512);
            if let Some(frame) = assembler.receive(&wire, MAX_BYTES).unwrap() {
                order.push(match frame {
                    Frame::RpcRes { .. } => 0,
                    Frame::WatchPush { rev, .. } => rev,
                    _ => panic!("unexpected frame"),
                });
            }
        }
        assert_eq!(order, vec![0, 1, 2]);
        assert!(outbox.waiting.is_empty());
    }

    const MAX_BYTES: usize = 32 * 1024;
}
