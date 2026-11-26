pub mod releases;

mod bundle;
mod fetch;
#[cfg(test)]
mod tests;
mod updater;

pub use bundle::{bundle_version, enter_bundle};
pub use updater::{UpdateOp, host_call, install, ready, version};
