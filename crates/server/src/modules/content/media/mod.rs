//! VibeValley's media services. Inputs share the attachment store; deleting
//! an input never deletes bytes that a message or library item still uses.
pub(in crate::modules::content::media) use crate::db::generated::content_media as q;
pub mod inputs;
pub mod validate;

pub mod image_provider;
pub mod png;

mod audio;
pub mod jobs;
mod remote;
mod understanding;
pub mod vendor;

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

/// Tells blocking or async vendor work to give up (a cancel, the farm closing).
#[derive(Clone, Default)]
pub struct Stop(Arc<CancellationToken>);

impl Stop {
    pub fn abort(&self) {
        self.0.cancel();
    }

    pub fn aborted(&self) -> bool {
        self.0.is_cancelled()
    }

    pub(super) fn same_as(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    pub(super) async fn cancelled(&self) {
        self.0.cancelled().await;
    }

    /// Waits for `duration`, returning `true` early if aborted.
    pub(super) fn wait_timeout(&self, duration: Duration) -> bool {
        if self.aborted() {
            return true;
        }
        vibevalley_runtime::rt::block_on(async {
            tokio::select! {
                biased;
                _ = self.0.cancelled() => true,
                _ = tokio::time::sleep(duration) => false,
            }
        })
    }
}
