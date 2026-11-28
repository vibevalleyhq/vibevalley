---
name: notes
description: Use when building structured documents (doc), multi-dimensional databases with agent columns (base), spatial canvases (canvas), or media/transcript notes (media). Read type guides with note_type_read first.
---

VibeValley supports 4 directory-backed `NoteType` primitives: `doc`, `base`, `canvas`, and `media`, all with hierarchical page trees (`note_tree_move`), bidirectional backlinks (`note_link_list`), and real-time Loro CRDT collaboration.

1. **Read the contract first**: Call `note_type_read` with `type` (`doc` | `base` | `canvas` | `media`) and `reference: "format"` (or MCP `skill://note/<type>/references/format.md`) before writing structured JSON.
2. **Prefer structured primitives over fragile plain Markdown**:
   - `base` (ledgers, triage queues, benchmarks): Query projected views with `note_base_view`, update single rows via `note_base_upsert_row` using tagged `BaseCellValue` (`_tag`), compute deltas with `formula` columns, attach long evidence via `pageNoteId` (Row=Page), and trigger batch `agentAction` columns via `note_base_run_agent_column`.
   - `doc` (specs, reports, acceptance evidence): Read with `note_doc_view`, append typed `DocBlock`s via `note_doc_append_block` (`kpi`, `baseEmbed`, `compare`, `callout`, `issueCard`, `toggle` with `collapsed: true`, `chart`, `diagram`, etc.), and reference `[[note:<id>]]`, `[[issue:<id>]]`, or `#123`.
   - `canvas` / `media`: Update `structure/board.json` or `structure/media.json` incrementally via `note_file_write`.
3. **Respect authorship**: Propose suggestions via `note_suggestion_create` on user-authored content instead of overwriting silently.
