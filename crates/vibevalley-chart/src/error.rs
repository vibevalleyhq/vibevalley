use thiserror::Error;

/// Structured errors returned when parsing, validating, or rendering a chart.
#[derive(Debug, Error)]
pub enum ChartError {
    #[error("chart input exceeds maximum size of {max_bytes} bytes (got {actual_bytes} bytes)")]
    InputTooLarge { actual_bytes: usize, max_bytes: usize },

    #[error("JSONC syntax error at byte {offset}: {message}")]
    JsoncSyntax { offset: usize, message: String },

    #[error("failed to parse chart specification JSON: {0}")]
    JsonParse(#[from] serde_json::Error),

    #[error("invalid chart dimension `{field}`: {message}")]
    InvalidDimension { field: &'static str, message: String },

    #[error("empty dataset in `{field}`: {message}")]
    EmptyData { field: &'static str, message: String },

    #[error("mismatched length in `{field}`: expected {expected}, got {actual}")]
    LengthMismatch { field: String, expected: usize, actual: usize },

    #[error("non-finite number (NaN or Infinity) in `{field}`")]
    NonFiniteValue { field: String },

    #[error("out-of-range value in `{field}`: {message}")]
    OutOfRange { field: String, message: String },

    #[error("invalid axis `{axis}`: {message}")]
    InvalidAxis { axis: &'static str, message: String },

    #[error("invalid color `{value}` in `{field}`: {message}")]
    InvalidColor { field: String, value: String, message: String },

    #[error("guardrail limit exceeded for `{field}`: maximum is {max}, got {actual}")]
    LimitExceeded { field: &'static str, max: usize, actual: usize },
}
