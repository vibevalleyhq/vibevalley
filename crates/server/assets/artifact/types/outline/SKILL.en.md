# outline: Tree Outline

`outline` is a lightweight single-column nested tree outline for rapid structuring, meeting notes, breakdowns, and brainstorming (`body = "blocks"`, created via `artifact_create` with `artifactType: "outline"`, suffix `.outline.md`). Unlike long-form prose `docs`, it favors crisp one-line nodes, deep nesting, folding, and branch focus.

## Workflow

1. **Create**: `artifact_create({ title, artifactType: "outline", content })` seeds an indented list tree, or omit `content` to start an empty outline.
2. **Model hierarchy with parent/child blocks**:
   - Use top-level nodes for themes or groups, `parentId` for nested children, and `afterBlock` for sibling ordering.
   - Prefer `bulleted` for points and `todo` (with `checked`) for actionable items.
   - Edit surgically via `artifact_block_create`, `artifact_block_update` (with `baseRev`), and `artifact_block_delete` rather than rewriting the whole outline.
3. **Respect user-authored nodes**: Agent edits to nodes written by the user become tracked suggestions for approval.

## Craft

- **One thought per node**: Keep each node concise and push supporting details, evidence, or sub-steps into child nodes so users can fold or zoom into any branch cleanly.
- **Know when to switch to `docs`**: Use `outline` for scannable trees and live decomposition; switch to `docs` for narrative essays, formal specs, or multi-paragraph prose.
