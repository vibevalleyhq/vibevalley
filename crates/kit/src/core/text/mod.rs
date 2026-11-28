//! UTF-16 code-unit safe text truncation and whitespace normalization.

mod utf16;

pub use utf16::{clip_utf16, collapse_whitespace, head, within};
