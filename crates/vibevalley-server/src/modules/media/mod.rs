//! VibeValley's media services. Inputs share the attachment store; deleting
//! an input never deletes bytes that a message or library item still uses.
#[rustfmt::skip]
#[path = "generated/queries.rs"]
mod q;
pub mod inputs;
pub mod validate;

pub mod image_provider;
pub mod png;

mod audio;
pub mod jobs;
mod remote;
mod understanding;
pub mod vendor;

/// Tells blocking vendor work to give up (a cancel, the farm closing).
#[derive(Clone, Default)]
pub struct Stop(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Stop {
    pub fn abort(&self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn aborted(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}
