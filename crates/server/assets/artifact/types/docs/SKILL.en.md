# docs: Collaborative Document

`docs` is for technical specs, PRDs, RFCs, research memos, and postmortems co-authored by humans and agents. Each artifact is a directory managed by `storage/` (`<storage>/artifact/<id>/`) containing multi-section Markdown under `structure/*.md` and local media under `asset/`, backed by the unified real-time collaboration engine.

## Directory Layout

```text
<storage>/artifact/<id>/
├── manifest.json          # id, artifactType: "docs", title, entry, ordered sections
├── structure/
│   ├── index.md           # Executive summary and entry section
│   ├── 01-context.md      # Focused chapter Markdown files
│   └── 02-architecture.md
└── asset/
    └── topology.png       # Referenced via relative path: ![Topology](asset/topology.png)
```

Example `manifest.json`:
```json
{
  "id": "art_01",
  "artifactType": "docs",
  "title": "Unified Collaboration Engine RFC",
  "entry": "structure/index.md",
  "sections": ["structure/index.md", "structure/01-context.md", "structure/02-architecture.md"]
}
```

## Multi-Human & Multi-Agent Collaboration Rules

1. **Unified CRDT sync (`artifact_collab`)**: Concurrent edits to `structure/*.md` merge conflict-free through `artifact_collab` and materialize cleanly to disk. Never rewrite an entire document when only a paragraph or section changes.
2. **Origin-tracked history (`artifact_change`)**: Every edit carries its `origin` (human or agent session/turn) for timeline replay, undo-by-origin, restore, and fork. Capture release milestones with immutable `artifact_version` directory snapshots.
3. **Review suggestions (`artifact_suggestion`)**: When revising prose authored or recently edited by a human, propose a tracked suggestion (create / accept / reject) rather than silently clobbering their wording.
4. **Live presence awareness**: Check active cursors and focused sections before editing. Partition concurrent agent writers across distinct `structure/*.md` files and avoid typing inside a paragraph currently held by a human.

## Native Blocks & Craft

- **Native ```` ```chart ```` and ```` ```genui ```` blocks**: Embed structured JSON fenced blocks inside `structure/*.md` for native charts (`bar`, `line`, `area`, `scatter`, `pie`, `donut`, `combo`, `heatmap`, etc.) or interactive calculators (`state` + `nodes`).
- **Local assets**: Store all images and supporting files in `asset/` and reference them with relative paths (`asset/<name>`). Never embed external hotlinks or multi-megabyte data URIs.
- **Lead with the decision**: Put the core conclusion in the opening paragraph of `structure/index.md`; use H2/H3 rhythm, `- [ ]` task lists, and inline `` `code` `` for identifiers.

Further references: `artifact_type_read({ type: "docs", reference: "structure" | "craft" })`.
