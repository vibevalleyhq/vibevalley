//! Orthogonal domain-agnostic error classification and dirty bitmasks.

mod class;
mod dirty;

pub use class::{ErrorClass, WireError};
pub use dirty::DirtyMask;
