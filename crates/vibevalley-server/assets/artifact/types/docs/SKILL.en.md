# docs: Collaborative Document

`docs` is for structured long-form writing edited together by humans and helpers (`body = "blocks"`, created via `artifact_create` with `artifactType: "docs"` or `kind: "markdown"`).

## Workflow

1. **Create**: `artifact_create({ title, artifactType: "docs", content })` seeds initial Markdown blocks, or omit `content` to start an empty block document.
2. **Surgical block edits (never rewrite whole documents)**:
   - Inspect current blocks and `rev` (and check `selectedBlockIds` in `<artifact-view-context>` when present).
   - Insert with `artifact_block_create`, update with `artifact_block_update` passing `baseRev`, remove with `artifact_block_delete`.
3. **Respect user-authored blocks**: Agent edits to blocks written by the user automatically become tracked suggestions for user approval.

## Craft

- **Lead with the decision**: Put the conclusion or recommendation in the opening paragraph.
- **Scannable rhythm**: Break sections with `heading` (levels 1–3), use `todo` for action items, `quote` for key callouts, and inline `` `code` `` for identifiers and paths.

Further reference: `artifact_type_read({ type: "docs", reference: "structure" })`.
