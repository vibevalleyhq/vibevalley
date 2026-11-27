---
name: canvas
description: Spatial canvas and diagramming primitive for whiteboards, architecture diagrams, flows, and visual frames stored in structure/board.json.
tags: [note, visual, canvas]
---

# canvas: Spatial Canvas & Diagrams

`canvas` stores spatial `elements` (keyed by element `id`), `grid`, `theme`, and `viewport` metadata in `structure/board.json` with companion assets under `asset/`.

- Read and update files incrementally with `note_file_list`, `note_file_get`, and `note_file_write`.
- Propose non-destructive edits on user-authored regions via `note_suggestion_create`.
