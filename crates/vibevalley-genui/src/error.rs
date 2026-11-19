use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum GenUiError {
    #[error("expression parse error at byte {pos}: {message}")]
    ExprParse { pos: usize, message: String },

    #[error("unknown function `{name}`")]
    UnknownFunction { name: String },

    #[error("invalid argument count for `{function}`: expected {expected}, got {actual}")]
    ArityMismatch { function: String, expected: String, actual: usize },

    #[error("undefined state variable `{name}`")]
    UndefinedVariable { name: String },

    #[error("type mismatch in {context}: expected {expected}, got {actual}")]
    TypeMismatch { context: String, expected: String, actual: String },

    #[error("division by zero")]
    DivisionByZero,

    #[error("non-finite numeric result in {context}")]
    NonFiniteResult { context: String },

    #[error("evaluation step limit ({limit}) exceeded")]
    StepLimitExceeded { limit: usize },

    #[error("nesting depth limit ({limit}) exceeded")]
    DepthLimitExceeded { limit: usize },

    #[error("collection length limit ({limit}) exceeded")]
    CollectionLimitExceeded { limit: usize },

    #[error("string length limit ({limit}) exceeded")]
    StringLimitExceeded { limit: usize },

    #[error("invalid range step: {message}")]
    InvalidRange { message: String },

    #[error("unknown format kind `{kind}`")]
    UnknownFormat { kind: String },

    #[error("invalid patch JSON: {message}")]
    InvalidPatchJson { message: String },

    #[error("stream line exceeded byte limit ({limit})")]
    LineTooLong { limit: usize },

    #[error("stream patch limit ({limit}) exceeded")]
    PatchLimitExceeded { limit: usize },

    #[error("stream already completed; ignoring trailing patch")]
    StreamAlreadyComplete,

    #[error("node `{id}` not found")]
    NodeNotFound { id: String },

    #[error("node `{id}` is `{kind}`, which cannot hold child nodes")]
    NotAContainer { id: String, kind: String },

    #[error("tab `{tab_id}` not found in tabs node `{node_id}`")]
    TabNotFound { node_id: String, tab_id: String },

    #[error("node `{id}` kind mismatch: expected `{expected}`, got `{actual}`")]
    NodeKindMismatch { id: String, expected: String, actual: String },

    #[error("append_child inline node id `{node_id}` does not match child_id `{child_id}`")]
    ChildIdMismatch { child_id: String, node_id: String },

    #[error("cycle detected involving node `{node_id}`")]
    CycleDetected { node_id: String },

    #[error("invalid property on node `{id}`: {message}")]
    InvalidNodeProp { id: String, message: String },

    #[error("node count limit ({limit}) exceeded")]
    NodeLimitExceeded { limit: usize },

    #[error("invalid UTF-8 in stream chunk")]
    InvalidUtf8,

    #[error("serialization error: {message}")]
    Serialization { message: String },
}
