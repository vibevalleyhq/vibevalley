# outline: Hierarchical Tree Outline

`outline` is a lightweight infinite-nesting tree outline for rapid decomposition, brainstorming, meeting notes, and structured thinking. Stored as a directory in `storage/` (`<storage>/artifact/<id>/`), its tree lives in `structure/outline.json` with supporting files under `asset/`. Unlike prose-heavy `docs`, `outline` optimizes for crisp one-line nodes, deep nesting, folding, and branch zoom.

## Directory Layout

```text
<storage>/artifact/<id>/
├── manifest.json          # id, artifactType: "outline", title, entry: "structure/outline.json"
├── structure/
│   └── outline.json       # Stable-ID node map, rootIds order, node kinds, props, and children
└── asset/
    └── ref-sketch.png     # Referenced via relative path asset/<name>
```

Minimal `structure/outline.json`:
```json
{
  "version": 1,
  "rootIds": ["n_goals", "n_risks"],
  "nodes": {
    "n_goals": { "id": "n_goals", "text": "Q3 Objectives", "kind": "heading", "children": ["n_g1"], "props": { "owner": "Core" } },
    "n_g1": { "id": "n_g1", "text": "Ship directory-per-artifact unified collab", "kind": "todo", "checked": false, "children": [] },
    "n_risks": { "id": "n_risks", "text": "Key Risks & Mitigations", "kind": "bullet", "children": [] }
  }
}
```

## Multi-Human & Multi-Agent Collaboration Rules

1. **Node-level CRDT sync (`artifact_collab`)**: Create, edit, reorder, and reparent nodes by stable `id` through `artifact_collab`. Never regenerate the whole JSON tree with fresh IDs—doing so breaks live cursors, zoom focus, and concurrent edits.
2. **Origin-tracked changes (`artifact_change`)**: Every mutation records its `origin` so users can inspect, fork, or undo an agent's expansion pass cleanly. Save milestones with `artifact_version`.
3. **Human-authored protection (`artifact_suggestion`)**: Propose tracked suggestions when rewording, merging, or deleting human-authored nodes; append supporting child nodes cleanly under open branches.
4. **Live presence awareness**: Respect active human focus/zoom branches and cursors—work on sibling or unassigned branches when collaborating concurrently.

## Craft

- **One thought per node**: Keep each node to a single crisp line; push rationale, examples, and sub-steps into child nodes so any branch folds and zooms cleanly.
- **Know the boundary**: Use `bullet`, `todo`, `quote`, and `props` for structured trees; switch to `docs` when narrative paragraphs or formal specs are required.

Further references: `artifact_type_read({ type: "outline", reference: "format" | "craft" })`.
