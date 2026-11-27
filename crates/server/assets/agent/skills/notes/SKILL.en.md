---
name: notes
description: Use when building structured documents (doc), multi-dimensional databases with agent columns (base), spatial canvases (canvas), or media/transcript notes (media). Read type guides with note_type_read first.
---

VibeValley supports 4 directory-backed `NoteType` primitives: `doc`, `base`, `canvas`, and `media`, all with hierarchical page trees (`note_tree_move`), bidirectional backlinks (`note_link_list`), and real-time Loro CRDT collaboration.

1. **Read the guide first**: Call `note_type_read` with `type` (`doc` | `base` | `canvas` | `media`) and optional `reference: "format"`.
2. **Edit incrementally**:
   - `doc`: Read with `note_doc_view`, append/insert blocks via `note_doc_append_block`, reference `[[note:<id>]]`, `[[issue:<id>]]`, or `#123`.
   - `base`: Query projected sheets/views with `note_base_view`, update single rows via `note_base_upsert_row`, or trigger batch `agentAction` columns via `note_base_run_agent_column`.
   - `canvas` / `media`: Update structured JSON files incrementally via `note_file_write`.
3. **Respect authorship**: Propose suggestions via `note_suggestion_create` on user-authored content instead of overwriting silently.
