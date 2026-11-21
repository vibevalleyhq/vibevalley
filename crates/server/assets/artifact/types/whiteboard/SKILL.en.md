# whiteboard: Infinite Collaborative & Editorial Canvas

`whiteboard` (`body = "store"`, `artifactType: "whiteboard"`) renders an infinite pan/zoom canvas with editorial typography, warm milestone cards, perched illustrations/stickers, curved timeline ribbons, smooth/orthogonal connectors, freehand paths, and live collaborator cursors. Every element lives independently at `elements/<id>`.

## Entry Layout

- `board/meta` (JSON): `{ "title": "...", "mode": "board", "grid": true }`
- `elements/<id>` (JSON):
  - `text`: `{ "id": "t1", "type": "text", "variant": "title" | "subtitle" | "callout" | "body", "x": 80, "y": 32, "w": 680, "h": 56, "label": "Launch Timeline", "highlight": "12 days", "icon": "⚠", "align": "left" | "center" }`
  - `shape`: `{ "id": "n1", "type": "shape", "shape": "card" | "sticky" | "rect" | "diamond" | "ellipse" | "pill", "x": 120, "y": 140, "w": 188, "h": 116, "title": "Lock scope", "body": "Milestone v1 locked", "fill": "sun" | "peach" | "leaf" | "water" | "lavender" | "berry" | "wheat" | "side" | "page", "sticker": "berry-lock", "badge": "Day 1" }` (`sticker` accepts a built-in hand-drawn sticker ID or emoji, or a sanitized inline `stickerSvg`).
  - `timeline`: `{ "id": "tl1", "type": "timeline", "x": 80, "y": 290, "w": 840, "h": 90, "fill": "peach", "points": [{ "x": 80, "y": 350 }, { "x": 380, "y": 320 }, { "x": 680, "y": 308 }, { "x": 920, "y": 280 }], "milestones": [{ "t": 0.08, "label": "Day 1", "kind": "major" }, { "t": 0.45, "label": "4", "kind": "minor", "caption": "4 days on the road" }] }`
  - `container`: `{ "id": "c1", "type": "container", "x": 80, "y": 80, "w": 600, "h": 340, "title": "Core Boundary", "fill": "side" }`
  - `arrow`: `{ "id": "a1", "type": "arrow", "curve": "smooth" | "orthogonal" | "straight", "style": "solid" | "dashed", "head": "arrow" | "none", "from": { "id": "n1", "side": "s" }, "to": { "id": "n2", "x": 220, "y": 340 }, "label": "...", "bends": [] }`
  - `path`: `{ "id": "p1", "type": "path", "points": [{ "x": 100, "y": 120 }, { "x": 160, "y": 140 }], "stroke": "#a83a2c", "strokeWidth": 3 }`
  - `sticker` / `svg`: `{ "id": "s1", "type": "sticker", "sticker": "truck", "x": 420, "y": 240, "w": 110, "h": 72 }` or `type: "svg"` with `svg` markup.
  - `table`, `html` (sandboxed widget with `embed.load()`/`embed.save()`), and temporary `claim` frames.
- `presence/<id>` (optional JSON): `{ "id": "orch", "name": "Assistant", "color": "coral" | "teal" | "blue" | "leaf" | "wheat" | "lavender", "x": 520, "y": 110, "status": "Drafting" }`.

Further references: `artifact_type_read({ type: "whiteboard", reference: "elements" | "pictures" })`.
