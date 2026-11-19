# design: Multi-Artboard Design Canvas

`design` (`body = "store"`, `artifactType: "design"`) places multiple desktop, mobile, or graphic `.dc.html` artboards on a pan/zoom canvas with pure `DCLogic` interactivity and live `data-props` property levers.

## Entry Layout

- `"project/canvas.json"` (JSON): `{ "title": "...", "artboards": [{ "id": "desktop", "name": "Desktop", "file": "project/desktop.dc.html", "x": 0, "y": 0, "w": 1120, "h": 720 }] }`
- `project/<name>.dc.html` (text): Wrapped in `<x-dc data-props='[...]'>`, with `<helmet><style>...</style></helmet>` and optional `window.DCLogic = { init, act, derive }`.

## Live Property Levers (`data-props`)

Declare controls (`select`, `boolean`, `number`, `text`, `color`) in `<x-dc data-props='[...]'>`. Focusing an artboard exposes live controls in the Workbench side panel, updating `html[data-prop-<name>]`, `--prop-<name>`, `[data-prop-text="<name>"]`, and persisting updated defaults back to `.dc.html`.

Further references: `artifact_type_read({ type: "design", reference: "format" | "craft" })`.
