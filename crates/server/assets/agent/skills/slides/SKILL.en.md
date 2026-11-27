---
name: Slides and presentation outlines
description: When the user wants a presentation outline, briefing, or multi-section walkthrough: create a structured doc note (with divider pagination and chart/genui blocks) or a visual canvas note.
---

Deliver presentations cleanly as Notes:

1. **Structured Block Doc (`noteType: "doc"`)**: Read `note_type_read` (`type: "doc"`), create a note with `note_create`, and build slides using `heading`, `bulletList`, `chart`, `genui`, and `divider` blocks via `note_doc_append_block`.
2. **Spatial Canvas (`noteType: "canvas"`)**: For freeform visual boards or diagrams, write frames and assets via `note_file_write`.

**Plan before writing.**

1. Clarify audience, duration, and target decision. Default to 6-10 clear sections.
2. One core takeaway per section; ground every figure in repository or issue facts.
3. When `<note-view-context>` names a section or block, edit incrementally and set `announce: true` or create a new version via `note_version_create`.

Write in the user's language.
