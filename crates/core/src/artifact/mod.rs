//! VibeValley's artifact engine that the server runs: block ops on a page, Markdown in and out, the HTML check,
//! words edited in a page, the shell an html version is shown in, and the
//! structured artifact store, tokens, starters, and sandboxed viewers.
//! Golden-tested against VibeValley's own functions (`gen/artifact.ts`).

pub mod html;
pub mod markdown;
pub mod ops;
pub mod shell;
pub mod spans;
pub mod starters;
pub mod store;
pub mod tokens;
pub mod viewers;

pub use html::{
    HtmlCheck, HtmlRefusal, InferredArtifactName, artifact_headers, artifact_problem, artifact_suffix_of, html_check, html_edit, html_problem,
    infer_artifact_from_name,
};
pub use markdown::{ImportedOutline, MdBlock, blocks_of_markdown, import_outline_markdown, inline_spans, markdown_of};
pub use ops::{Page, Revision, RevisionKind, ordered, wire};
pub use shell::{motion_recorder_helper, shell_theme_of, with_shell};
pub use spans::{plain, unmarked};
pub use starters::starter_entries_for_type;
pub use store::{
    ArtifactEntry, ArtifactEntryKind, ArtifactEntryOp, ArtifactEntryWriteInput, ArtifactType, ENTRY_MAX_BYTES, ENTRY_MAX_COUNT, INLINE_EVENT_MAX_BYTES,
    apply_json_merge_patch, canonical_json, entry_path_problem, format_store_summary, infer_entry_kind, infer_entry_mime,
};
pub use tokens::{ParsedColorSwatch, ParsedFamily, ParsedTokenValue, ParsedTokensSpec, ParsedTypeStyle, contrast_ratio, parse_tokens_spec};
pub use viewers::{
    RenderStoreOptions, StoreViewQuery, render_store_artifact_html, sanitize_whiteboard_svg, store_html_problem, store_view_headers, store_view_url,
    write_props_into_dc_html,
};
