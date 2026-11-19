# slides: Structured Slide Deck

`slides` (`body = "store"`, `artifactType: "slides"`) stores a multi-file presentation deck supporting surgical single-slide edits, `.fragment` progressive reveal, dual-window presenter sync, inline text edits, and vector PDF export.

## Entry Layout

- `"project/deck.json"` (JSON): `{ "title": "...", "aspectRatio": "16:9" | "4:3", "slides": [{ "id": "s01", "file": "s01.html", "title": "...", "notes": "..." }] }`
- `"project/deck.css"` (text): Shared deck CSS classes and theme overrides. Standing default `design-system` tokens (`--color-*`, `--font-*`) are injected automatically.
- `project/slides/<file>` (text): Self-contained slide HTML fragment (`<div class="slide">...</div>`). Never write `<html>`, `<body>`, or custom paging scripts.
- `assets/<name>` (asset): Uploaded images/fonts referenced as `assets/<name>`.

## Rules

1. **One idea per slide, varied layouts**: Never stack three identical bullet slides in a row; alternate hero titles, big-number KPI grids, two-column comparisons, diagrams, and callout quotes.
2. **Step reveals**: Add `class="fragment"` to elements that reveal sequentially on click/arrow; PDF print expands all fragments automatically.
3. **Zero overflow**: Design strictly inside `1920×1080` (`16:9`) or `1440×1080` (`4:3`) with generous margins.

Further references: `artifact_type_read({ type: "slides", reference: "format" | "craft" | "layout" })`.
