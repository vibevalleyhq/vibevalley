//! The in-process server's contract. `vibevalley-bridge` and `vibevalley-http`
//! serve views through [`Server`]; `vibevalley-server` implements it. Payloads,
//! frames and events are VibeValley's protocol JSON.

pub use vibevalley_protocol::{ApiError, BizCode, Envelope, LiveEvent};

pub use vibevalley_chord::watch::Document;

pub mod media;

/// The helpers' MCP door (`POST /mcp`): one JSON-RPC message from a helper
/// with the bearer token it was given. `None` answers a notification.
pub trait Mcp: Send + Sync {
    fn message(&self, token: &str, message: serde_json::Value) -> Option<serde_json::Value>;
}

pub type SharedMcp = std::sync::Arc<dyn Mcp>;

/// What the server provides to the views.
pub trait Server: Send + Sync {
    /// One endpoint by name (`issue.status.update`, ...). Blocking; never
    /// called on the UI thread.
    fn call(&self, op: &str, payload: serde_json::Value) -> Envelope;
    /// `StateFrame`s, at most one every 200 ms. Each call returns a new
    /// receiver that gets every frame from then on, starting with the
    /// current one.
    fn state(&self) -> flume::Receiver<serde_json::Value>;
    /// Latest workbench state only. Slow views may skip revisions. Farm animation consumers use `state` for ordered effects.
    /// Blocks on the caller's worker until `stop` disconnects.
    fn watch_workbench(&self, stop: &flume::Receiver<()>, receive: &mut dyn FnMut(&serde_json::Value)) {
        let states = self.state();
        while !stop.is_disconnected() {
            let next = flume::Selector::new().recv(stop, |_| None).recv(&states, |r| r.ok()).wait();
            let Some(mut frame) = next else { break };
            for recent in states.drain() {
                frame = recent;
            }
            if let Some(effects) = frame.get_mut("effects") {
                *effects = serde_json::Value::Array(vec![]);
            }
            receive(&frame);
        }
    }
    /// `LiveEvent`s from now on; a new receiver per call.
    fn live(&self) -> flume::Receiver<LiveEvent>;
    /// One of `rpc.ts`'s subscriptions. `Err` is a refusal before the first
    /// event. The stream ends when the server drops its sender.
    #[allow(clippy::result_large_err, reason = "the approved contract returns the refusal envelope itself")]
    fn subscribe(&self, name: &str, payload: serde_json::Value) -> Result<(u64, flume::Receiver<serde_json::Value>), Envelope>;
    fn unsubscribe(&self, id: u64);
    fn channel_messages_after(&self, _channel: &str, _after: i64, _limit: i64) -> Result<Vec<vibevalley_protocol::ChatMessage>, ApiError> {
        Err(ApiError::new(BizCode::ServiceUnavailable, "channel history unavailable"))
    }
    fn resolve_approval(&self, _input: serde_json::Value) -> Envelope {
        refusal(BizCode::Refused, "durable approvals unavailable")
    }
    fn raise_budget(&self, _input: serde_json::Value) -> Envelope {
        refusal(BizCode::Refused, "durable budgets unavailable")
    }
    fn space_document(&self) -> Option<Document> {
        None
    }

    /// Optional local binary media transport.
    fn media_inputs(&self) -> Option<media::SharedMediaInputs> {
        None
    }
    /// Streamed speech for the page, when the server runs it.
    fn speech_streams(&self) -> Option<media::SharedSpeechStreams> {
        None
    }
    /// The helpers' MCP door, when the server has one.
    fn mcp(&self) -> Option<SharedMcp> {
        None
    }
}

/// An envelope refusing with `code`.
pub fn refusal(code: BizCode, message: impl Into<String>) -> Envelope {
    Envelope::failure(&ApiError::new(code, message))
}
