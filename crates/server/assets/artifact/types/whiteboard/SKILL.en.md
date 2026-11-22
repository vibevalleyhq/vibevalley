# whiteboard: Infinite Collaborative & Editorial Canvas

`whiteboard` (`body = "store"`, `artifactType: "whiteboard"`) is rendered natively in pure Rust by `VvWhiteboard` (`crates/rich/src/whiteboard.rs` and `engine/whiteboard/*`), featuring dual-layer GPUI canvases (LRU-cached static layer + overlay selection/cursor layer), architectural/dot grids, editorial serif typography, warm milestone cards, vivid workshop sticky notes, capsule plan flows, external container section titles, 25 perched illustrations/stickers across 6 categories, curved timeline ribbons, smooth/orthogonal/straight connectors, pressure-sensitive pen and highlighter strokes, eraser, alignment/distribution/tidy, collaborator cursor speech bubbles (`presence.status`), workshop countdown timer, 6 bilingual starter templates (including Launch Workshop), minimap, JSON Canvas 1.0 (`.canvas`) interoperability, and SVG / 2x PNG / JSON export. Every element lives independently at `elements/<id>`.

## Entry Layout

- `board/meta` (JSON): `{ "title": "...", "mode": "board", "grid": "architectural" | "dots" | "none" }` (boolean `grid` also supported)
- `elements/<id>` (JSON):
  - `text`: `{ "id": "t1", "type": "text", "variant": "title" | "subtitle" | "callout" | "body", "x": 80, "y": 32, "w": 680, "h": 56, "label": "Launch Timeline", "highlight": "12 days", "icon": "⚠", "align": "left" | "center" }`
  - `shape`: `{ "id": "n1", "type": "shape", "shape": "card" | "sticky" | "rect" | "diamond" | "ellipse" | "cylinder" | "triangle" | "pill", "x": 120, "y": 140, "w": 188, "h": 116, "title": "Lock scope", "body": "Milestone v1 locked", "fill": "sun" | "peach" | "leaf" | "water" | "lavender" | "berry" | "wheat" | "side" | "page", "sticker": "berry-lock", "badge": "Day 1" }` (`sticker` accepts any of the 25 built-in sticker IDs, emoji, or sanitized inline `stickerSvg`).
  - `timeline`: `{ "id": "tl1", "type": "timeline", "x": 80, "y": 290, "w": 840, "h": 90, "fill": "peach", "points": [{ "x": 80, "y": 350 }, { "x": 380, "y": 320 }, { "x": 680, "y": 308 }, { "x": 920, "y": 280 }], "milestones": [{ "t": 0.08, "label": "Day 1", "kind": "major" }, { "t": 0.45, "label": "4", "kind": "minor", "caption": "4 days on the road" }] }`
  - `container`: `{ "id": "c1", "type": "container", "x": 80, "y": 80, "w": 600, "h": 340, "title": "Core Boundary", "fill": "side" }`
  - `arrow`: `{ "id": "a1", "type": "arrow", "curve": "smooth" | "orthogonal" | "straight", "style": "solid" | "dashed", "head": "arrow" | "none", "from": { "id": "n1", "side": "s" }, "to": { "id": "n2", "x": 220, "y": 340 }, "label": "...", "bends": [] }`
  - `path`: `{ "id": "p1", "type": "path", "mode": "pen" | "highlighter", "points": [{ "x": 100, "y": 120, "pressure": 0.7 }, { "x": 160, "y": 140, "pressure": 0.8 }], "stroke": "#a83a2c", "strokeWidth": 3 }`
  - `sticker` / `svg`: `{ "id": "s1", "type": "sticker", "sticker": "truck", "x": 420, "y": 240, "w": 110, "h": 72 }` or `type: "svg"` with `svg` markup.
  - `table`, `html` widgets, and temporary `claim` frames.
- `presence/<id>` (optional JSON): `{ "id": "orch", "name": "Orchestrator", "color": "coral" | "teal" | "blue" | "leaf" | "wheat" | "lavender", "x": 520, "y": 110, "status": "Drafting" }`.

Built-in templates cover Timeline, Launch Workshop, Architecture, User Journey, 2x2 Quadrant, and Comparison Table in both English and Chinese.

Further references: `artifact_type_read({ type: "whiteboard", reference: "elements" | "pictures" })`.
