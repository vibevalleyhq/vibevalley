//! VibeValley's media services. Inputs share the attachment store; deleting
//! an input never deletes bytes that a message or library item still uses.
pub mod inputs;
mod validate;

pub mod image_provider;
pub mod png;

pub mod machine;
