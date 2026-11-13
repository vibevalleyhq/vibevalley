//! The in-process server's contract (approved 2026-11-13; see
//! `docs/vibevalley-port.md` § Bridge). `vibevalley-bridge` and `vibevalley-http`
//! serve views through [`Server`]; `vibevalley-server` implements it. Payloads,
//! frames and events are VibeValley's protocol JSON.

pub use vibevalley_protocol::{ApiError, BizCode, Envelope, LiveEvent};

pub mod media;

/// What the server provides to the views.
pub trait Server: Send + Sync {
    /// One endpoint by name (`issue.status.update`, ...). Blocking; never
    /// called on the UI thread.
    fn call(&self, op: &str, payload: serde_json::Value) -> Envelope;
    /// `StateFrame`s, at most one every 200 ms. Each call returns a new
    /// receiver that gets every frame from then on, starting with the
    /// current one.
    fn state(&self) -> flume::Receiver<serde_json::Value>;
    /// `LiveEvent`s from now on; a new receiver per call.
    fn live(&self) -> flume::Receiver<LiveEvent>;
    /// One of `rpc.ts`'s subscriptions. `Err` is a refusal before the first
    /// event. The stream ends when the server drops its sender.
    #[allow(clippy::result_large_err, reason = "the approved contract returns the refusal envelope itself")]
    fn subscribe(&self, name: &str, payload: serde_json::Value) -> Result<(u64, flume::Receiver<serde_json::Value>), Envelope>;
    fn unsubscribe(&self, id: u64);
    /// Optional local binary media transport.
    fn media_inputs(&self) -> Option<media::SharedMediaInputs> {
        None
    }
}

/// An envelope refusing with `code`.
pub fn refusal(code: BizCode, message: impl Into<String>) -> Envelope {
    Envelope::failure(&ApiError::new(code, message))
}
