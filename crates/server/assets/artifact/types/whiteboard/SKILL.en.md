# whiteboard: Infinite Collaborative Canvas

`whiteboard` (`body = "store"`, `artifactType: "whiteboard"`) renders a native infinite pan/zoom canvas where each shape, container, orthogonal arrow, table, SVG diagram, or sealed HTML widget is an independent entry at `elements/<id>`.

## Entry Layout

- `board/meta` (JSON): `{ "title": "...", "mode": "board", "grid": true }`
- `elements/<id>` (JSON):
  - `shape`: `{ "id": "n1", "type": "shape", "shape": "rect" | "sticky" | "diamond" | "ellipse", "x": 120, "y": 140, "w": 200, "h": 84, "label": "...", "fill": "leaf" | "water" | "wheat" | "berry" | "neutral" }`
  - `container`: `{ "id": "c1", "type": "container", "x": 80, "y": 80, "w": 600, "h": 340, "label": "Zone" }`
  - `arrow`: `{ "id": "a1", "type": "arrow", "from": { "id": "n1", "side": "e" }, "to": { "id": "n2", "side": "w" }, "label": "...", "bends": [] }`
  - `text`: `{ "id": "t1", "type": "text", "x": 120, "y": 40, "w": 320, "h": 36, "label": "Heading" }`
  - `table`: `{ "id": "tb1", "type": "table", "x": 120, "y": 480, "w": 460, "h": 160, "headers": ["Col A", "Col B"], "rows": [["1", "2"]] }`
  - `svg`: `{ "id": "s1", "type": "svg", "x": 740, "y": 120, "w": 220, "h": 160, "sketch": "marker" | "clean", "svg": "<svg viewBox=\"0 0 220 160\">...</svg>" }`
  - `html`: `{ "id": "h1", "type": "html", "x": 740, "y": 320, "w": 300, "h": 200, "html": "...", "state": {} }`
  - `claim`: Temporary agent bounding frame removed once elements land.

Further references: `artifact_type_read({ type: "whiteboard", reference: "elements" | "pictures" })`.
