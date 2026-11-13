//! VibeValley's `packages/artifact`, the part the
//! server runs: block ops on a page, Markdown in and out, the HTML check,
//! words edited in a page, and the shell an html version is shown in.
//! Golden-tested against VibeValley's own functions (`gen/artifact.ts`).

pub mod html;
pub mod markdown;
pub mod ops;
pub mod shell;
pub mod spans;

pub use html::{ARTIFACT_MAX, HtmlCheck, HtmlRefusal, artifact_headers, artifact_problem, html_check, html_edit, html_problem};
pub use markdown::{MdBlock, blocks_of_markdown, inline_spans, markdown_of};
pub use ops::{Page, Revision, RevisionKind, ordered, wire};
pub use shell::{shell_path, shell_theme_of, with_shell};
pub use spans::{normal_spans, plain, rune_len, same_text, split_at, unmarked};
