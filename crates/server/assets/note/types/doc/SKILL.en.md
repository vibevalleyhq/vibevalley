---
name: doc
description: Structured Block Document primitive supporting nested blocks, charts, GenUI, bidirectional links, and real-time Loro CRDT collaboration.
tags: [note, writing, doc]
---

# doc: Structured Block Document

`doc` is the unified Notion-style block document primitive in VibeValley stored at `<storage>/note/<id>/`, with primary entry `structure/doc.json`.

## Operations

- Inspect blocks and extracted links via `note_doc_view`.
- Append or insert a `DocBlock` via `note_doc_append_block`.
- Reference other notes or issues with `[[note:<id>]]`, `[[issue:<id>]]`, or `#123`; backlinks are indexed automatically (`note_link_list`).
- Propose non-destructive edits on human-authored blocks using `note_suggestion_create`.
