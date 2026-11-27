---
name: base
description: Multi-dimensional database primitive with table/board/gallery/timeline views, Rust-computed filters/sorts/groups/summaries, and batch Agent Action columns.
tags: [note, database, base]
---

# base: Multi-Dimensional Database

`base` stores multi-sheet structured tables in `structure/base.json`.

- Query filtered/sorted/grouped projections via `note_base_view`.
- Insert or update rows via `note_base_upsert_row`.
- Execute `agentAction` columns across selected rows via `note_base_run_agent_column` to render row prompts, optionally spawn Issues, and record outcomes.
