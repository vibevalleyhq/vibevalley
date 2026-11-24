# whiteboard: Infinite Collaborative & Editorial Canvas

`whiteboard` is a natively rendered infinite spatial canvas supporting architectural/dot grids, snap/align/tidy, warm milestone cards, vivid workshop stickies, external-title containers, curved timeline ribbons, 25 perched editorial stickers, pressure-sensitive pen/highlighter strokes, smooth/orthogonal/straight connectors, and JSON Canvas interoperability. Stored as a directory in `storage/` (`<storage>/artifact/<id>/`), canvas data lives in `structure/board.json` and external graphics in `asset/`.

## Directory Layout

```text
<storage>/artifact/<id>/
├── manifest.json          # id, artifactType: "whiteboard", title, entry: "structure/board.json"
├── structure/
│   └── board.json         # Grid config, viewport hint, and stable-ID elements map
└── asset/
    └── sketch-hero.svg    # External vector/image assets referenced via asset/<name>
```

Minimal `structure/board.json`:
```json
{
  "version": 1,
  "grid": "architectural",
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "elements": {
    "t1": { "id": "t1", "type": "text", "variant": "title", "x": 80, "y": 32, "w": 680, "h": 54, "label": "Launch Timeline", "highlight": "12 days" },
    "n1": { "id": "n1", "type": "shape", "shape": "card", "x": 120, "y": 140, "w": 200, "h": 116, "title": "Lock scope", "body": "Milestone v1 locked", "fill": "sun", "sticker": "berry-lock" },
    "e1": { "id": "e1", "type": "arrow", "curve": "smooth", "from": { "id": "n1", "side": "e" }, "to": { "id": "n2", "side": "w" }, "label": "Handoff" }
  }
}
```

## Multi-Human & Multi-Agent Collaboration Rules

1. **Element-level CRDT sync (`artifact_collab`)**: Mutate individual keys under `elements[id]` (e.g., updating only `x`/`y` or `title`) through `artifact_collab`. Never overwrite the full `elements` map, which clobbers concurrent drags and strokes.
2. **Origin-tracked history (`artifact_change`)**: Every placement and tidy pass records its `origin` so users can replay workshop evolution, undo an agent's layout pass, or fork options; snapshot milestones with `artifact_version`.
3. **Review suggestions (`artifact_suggestion`)**: Propose tracked suggestions before deleting or rewriting human-authored cards and stickies; prefer placing alternative groupings in open canvas space.
4. **Live presence & spatial etiquette**: Cursors, viewports, and status bubbles flow over ephemeral presence broadcasts—never persist presence into `structure/board.json`. Check occupied coordinates before drawing and use a temporary `claim` frame while authoring dense clusters.

## Spatial Craft

- Anchor every board with a `title` + `subtitle` (`highlight` key metrics), then organize steps into warm `card` nodes with perched `sticker` accents and `container` zones (`parentId`).
- Leave `64px–100px` gutters between cards so smooth connectors and perched stickers breathe cleanly.

Further references: `artifact_type_read({ type: "whiteboard", reference: "elements" | "pictures" })`.
