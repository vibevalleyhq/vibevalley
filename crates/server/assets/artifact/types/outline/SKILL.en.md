# outline: Tree Outline

`outline` is a lightweight single-column nested tree outline for rapid structuring, meeting notes, breakdowns, and brainstorming (`body = "blocks"`, created via `artifact_create` with `artifactType: "outline"`, suffix `.outline.md`). Unlike long-form prose `docs`, it favors crisp one-line nodes, deep nesting, folding, and branch focus.

## Workflow

1. **Create or import**:
   - Create fresh: `artifact_create({ title, artifactType: "outline", content })` seeds an indented list tree, or omit `content` to start empty.
   - Import Markdown / Logseq notes: `artifact_outline_import({ markdown, title, filename })` (helpers may pass workspace `file`), parsing YAML frontmatter, `key:: value` properties, nested indentation, and `TODO`/`DOING`/`DONE`/`CANCELED` task items into an `outline` artifact.
2. **Model hierarchy with parent/child blocks**:
   - Inspect current nodes and `rev` via `artifact_block_list({ id })`; prefer `artifact_block_batch({ id, ops })` for multi-node `create` (with `tempId`), `update` (with `baseRev`), `move`, and `delete`, or use `artifact_block_create` / `update` / `delete` for single edits.
   - Use top-level nodes for themes or groups, `parentId` for nested children, and `afterBlock` for sibling ordering.
   - Prefer `bulleted` for points and `todo` (with `checked`) for actionable items; embed `type: "code"` with `language: "chart"` or `"genui"` when a branch needs a native chart or interactive calculator.
3. **Respect user-authored nodes**: Agent edits to nodes written by the user become tracked suggestions for approval.

## Craft

- **One thought per node**: Keep each node concise and push supporting details, evidence, or sub-steps into child nodes so users can fold or zoom into any branch cleanly.
- **Know when to switch to `docs`**: Use `outline` for scannable trees and live decomposition; switch to `docs` for narrative essays, formal specs, or multi-paragraph prose.
