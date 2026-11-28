# Canvas JSON Format (`structure/board.json`)

`structure/board.json` stores a spatial whiteboard/diagram document rendered by native `VvWhiteboard` (`crates/rich/src/engine/whiteboard/codec.rs`). Keys are camelCase.

## Top-Level Shape

```json
{
  "version": 1,
  "grid": "architectural",
  "theme": "warm",
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "elements": {
    "t1": {
      "id": "t1",
      "type": "text",
      "variant": "title",
      "x": 80,
      "y": 40,
      "w": 640,
      "h": 54,
      "label": "System Topology"
    },
    "g1": {
      "id": "g1",
      "type": "container",
      "x": 80,
      "y": 120,
      "w": 640,
      "h": 240,
      "title": "Rust Control Plane",
      "fill": "side",
      "collapsed": false
    },
    "n1": {
      "id": "n1",
      "type": "shape",
      "shape": "card",
      "x": 120,
      "y": 180,
      "w": 220,
      "h": 96,
      "title": "Router",
      "body": "Exhaustive EndpointId dispatch",
      "fill": "sun"
    },
    "n2": {
      "id": "n2",
      "type": "shape",
      "shape": "card",
      "x": 440,
      "y": 180,
      "w": 220,
      "h": 96,
      "title": "Service",
      "body": "Single SeaORM persistence door",
      "fill": "leaf"
    },
    "e1": {
      "id": "e1",
      "type": "arrow",
      "from": { "id": "n1", "side": "e" },
      "to": { "id": "n2", "side": "w" },
      "curve": "smooth",
      "endHead": "arrow",
      "label": "ctx.service"
    }
  }
}
```

## Board Metadata

- `version`: `1`
- `grid`: `"architectural"` | `"dots"` | `"none"`
- `theme`: `"warm"` | `"dark"` (optional)
- `viewport`: `{ "x": number, "y": number, "zoom": number }`
- `elements`: map of `elementId -> Element`

## Common Element Fields

Every element under `elements.<id>` may carry:
- `id` (`string`): matches map key
- `type` (`string`): element discriminator below
- `x`, `y`, `w`, `h` (`number`): canvas coordinates in world pixels
- `z?` (`number`), `locked?` (`boolean`), `groupId?` (`string`), `parentId?` (`string`), `rotation?` (`number`, degrees), `opacity?` (`0..1`)
- `fill?`: preset `"default"` | `"sun"` | `"peach"` | `"leaf"` | `"water"` | `"lavender"` | `"berry"` | `"side"`, or `#hex`

## Supported Element Types

| `type` | Key Fields |
|---|---|
| `text` / `callout` | `variant`: `"title"\|"subtitle"\|"callout"\|"body"`, `label`, `align`: `"left"\|"center"\|"right"`, `fontSize?`, `highlight?`, `icon?`, `color?`, `fill?` |
| `shape` | `shape`: `"card"\|"sticky"\|"rect"\|"rounded"\|"diamond"\|"ellipse"\|"pill"\|"triangle"\|"cylinder"`, `title`, `body?`, `fill?`, `stroke?`, `style`: `"solid"\|"dashed"\|"dotted"`, `cornerRadius?`, `badge?`, `sticker?`, `align?` |
| `container` (`frame`/`group`) | `title`, `fill?`, `stroke?`, `collapsed?: boolean` |
| `arrow` (`connector`) | `from` / `to`: `{ "id": "<elId>", "side"?: "n"\|"e"\|"s"\|"w" }` or `{ "x": number, "y": number }`, `bends?: [{ x, y }]`, `curve`: `"smooth"\|"orthogonal"\|"straight"`, `style`: `"solid"\|"dashed"\|"dotted"`, `startHead` / `endHead`: `"arrow"\|"none"\|"diamond"\|"dot"`, `stroke?`, `strokeWidth?`, `label?` |
| `timeline` | `points: [{ x, y }]`, `milestones: [{ t?, x?, y?, label, kind?: "major"\|"minor", tone?, caption? }]`, `fill?` |
| `path` | `points: [{ x, y, pressure? }]`, `stroke`, `strokeWidth`, `mode`: `"pen"\|"highlighter"` |
| `sticker` | `sticker` (icon/preset name), `svg?`, `label?` |
| `svg` | `svg` (inline SVG markup), `label?` |
| `image` | `uri` (`asset/...` or attachment URL), `attachmentId?`, `alt?`, `crop?: { x, y, w, h }` |
| `table` | `headers: string[]`, `rows: string[][]`, `fill?` |
| `claim` | `label`, `agentId?`, `status?` (live agent editing claim zone) |
| `html` | `html` (sandboxed HTML snippet), `title?` |

Update `structure/board.json` via `note_file_write` (using `expectedHash` when modifying existing content) or propose non-destructive edits on human-drawn boards via `note_suggestion_create`.
