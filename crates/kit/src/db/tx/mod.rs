//! Transactional post-commit hooks and dirty-mask propagation.

pub mod hook;
pub mod runner;

pub use hook::PostCommitHooks;
pub use runner::run_with_hooks;
