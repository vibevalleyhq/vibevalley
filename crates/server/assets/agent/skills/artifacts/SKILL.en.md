---
name: Structured Artifacts
description: When building dashboards, motion films, whiteboards, multi-artboard UI designs, design systems, tree outlines, or collaborative docs: read the type guide with artifact_type_read and edit incrementally with artifact_block_* or artifact_entry_batch.
---

The workbench supports 8 structured `ArtifactType`s: `docs`, `outline`, `slides`, `dashboard`, `motion`, `whiteboard`, `design`, and `design-system`.

1. **Read the guide before writing**: Call `artifact_type_read` with `type` to inspect the entry layout, sandbox runtime globals, and quality checks; pass `reference` when you need a deeper chapter.
2. **Keep structure and presentation clean**:
   - `dashboard`: store raw records in `datasets/<id>`, compute metrics via `window.dash` in `files/index.html`, and tag headline KPIs with `data-source` and `data-field` for automatic provenance verification.
   - `motion`: write deterministic pure-time `window.CUT.render(t, stage, kit)` in `film/script` so timeline scrubbing and WebM video export match frame-for-frame.
   - `whiteboard`: store individual elements under `elements/<id>` (`shape`, `container`, `arrow`, `table`, `svg`, `html`) so users and agents can co-edit on the infinite canvas.
   - `design`: place artboards in `project/*.dc.html` and expose `data-props` levers for live tweaking.
   - `design-system`: define light/dark tokens in `"project/tokens.json"`; when marked default, visual artifacts inherit its CSS custom properties automatically.
3. **Edit incrementally**: For block artifacts (`docs`/`outline`), read current blocks and `rev` with `artifact_block_list` and apply multi-op changes with `artifact_block_batch` (import workspace `.md`/Logseq notes via `artifact_outline_import`); embed `language: "chart"` or `"genui"` code blocks for native charts and interactive UIs. For store artifacts, use `artifact_entry_batch` (`set`, `patch`, `delete`, `copy` with optional `ifRev`) to update only changed entries, setting `announce: true` when handing a completed revision back to the channel.
