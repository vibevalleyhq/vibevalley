# Base JSON Format (`structure/base.json`)

`structure/base.json` stores a serialized `BaseDocument` (`crates/protocol/src/contract/note.rs`, evaluated by `crates/core/src/note/base.rs`). Every key is camelCase.

## Top-Level Shape

```json
{
  "version": 1,
  "sheets": [
    {
      "id": "sheet1",
      "name": "Patrol Ledger",
      "columns": [
        { "id": "c_target", "name": "Target", "kind": "text", "width": 220 },
        {
          "id": "c_verdict",
          "name": "Verdict",
          "kind": "select",
          "options": [
            { "value": "kept", "label": "Kept", "color": "green" },
            { "value": "reverted", "label": "Reverted", "color": "amber" },
            { "value": "needs-human", "label": "Needs Human", "color": "stone" }
          ],
          "width": 140
        },
        { "id": "c_tags", "name": "Tags", "kind": "multiSelect", "options": [{ "value": "rust", "label": "Rust", "color": "blue" }] },
        { "id": "c_before", "name": "Before", "kind": "number", "width": 100 },
        { "id": "c_after", "name": "After", "kind": "number", "width": 100 },
        { "id": "c_delta", "name": "Delta", "kind": "formula", "formula": "{c_after} - {c_before}", "width": 100 },
        { "id": "c_date", "name": "Date", "kind": "date", "width": 120 },
        { "id": "c_verified", "name": "Verified", "kind": "checkbox", "width": 90 },
        { "id": "c_shot", "name": "Screenshot", "kind": "media", "width": 140 },
        { "id": "c_issue", "name": "Issue", "kind": "issueRef", "width": 120 },
        { "id": "c_owner", "name": "Agent", "kind": "agentRef", "width": 120 },
        { "id": "c_note", "name": "Evidence Note", "kind": "noteRef", "width": 140 },
        {
          "id": "c_action",
          "name": "Spawn Fix",
          "kind": "agentAction",
          "agentConfig": {
            "agentId": "backend",
            "promptTemplate": "Investigate {{Target}} (delta={{c_delta}}, row={{row_id}})",
            "targetColumnId": "c_target",
            "spawnIssueRepo": "vibevalley"
          }
        }
      ],
      "rows": [
        {
          "id": "r1",
          "cells": {
            "c_target": { "_tag": "text", "value": "crates/server/src/router.rs" },
            "c_verdict": { "_tag": "text", "value": "kept" },
            "c_tags": { "_tag": "strings", "items": ["rust"] },
            "c_before": { "_tag": "number", "value": 131 },
            "c_after": { "_tag": "number", "value": 124 },
            "c_date": { "_tag": "text", "value": "2026-11-28" },
            "c_verified": { "_tag": "bool", "value": true },
            "c_shot": { "_tag": "text", "value": "asset/vdp-after.png" },
            "c_issue": { "_tag": "issueRef", "issueId": "i161" },
            "c_owner": { "_tag": "agentRef", "agentId": "backend" },
            "c_note": { "_tag": "noteRef", "noteId": "note_01..." }
          },
          "pageNoteId": "note_01_row_page",
          "createdAt": 1732752000000,
          "updatedAt": 1732752000000
        }
      ],
      "views": [
        {
          "id": "v_table",
          "name": "All Rows",
          "kind": "table",
          "hiddenColumns": [],
          "filters": [{ "columnId": "c_target", "op": "notEmpty" }],
          "sorts": [{ "columnId": "c_delta", "desc": false }],
          "summaries": [
            { "columnId": "c_target", "op": "count" },
            { "columnId": "c_delta", "op": "sum" }
          ]
        },
        {
          "id": "v_board",
          "name": "By Verdict",
          "kind": "board",
          "groupBy": "c_verdict"
        },
        {
          "id": "v_gallery",
          "name": "Snapshots",
          "kind": "gallery"
        },
        {
          "id": "v_timeline",
          "name": "Timeline",
          "kind": "timeline"
        }
      ]
    }
  ]
}
```

## All 12 `BaseColumnKind` Values

`BaseColumn` fields: `id`, `name`, `kind`, optional `options?: BaseSelectOption[]`, `agentConfig?: BaseAgentColumnConfig`, `formula?: string`, `width?: number`.

| `kind` | Cell `_tag` | Column Config & Semantics |
|---|---|---|
| `text` | `text` | Plain text or Markdown with `[[note:...]]` / `[[issue:...]]` links |
| `number` | `number` | Numeric scalar; eligible for `sum`/`avg`/`min`/`max` summaries and arithmetic formulas |
| `select` | `text` | Single choice; configure `options: [{ value, label?, color? }]` (`stone`, `amber`, `green`, `red`, `blue`, `purple`) |
| `multiSelect` | `strings` | Multiple choice tags; configure `options` as above |
| `date` | `text` | ISO-8601 date (`"2026-11-28"`) or range; drives `timeline` view |
| `checkbox` | `bool` | Boolean toggle (`true` -> `1.0`, `false` -> `0.0` in numeric formulas) |
| `media` | `text` or `strings` | Relative `asset/...` path(s) or attachment id; drives `gallery` cover |
| `issueRef` | `issueRef` | Live link to an `Issue` (`issueId`); indexed into `note_link` |
| `agentRef` | `agentRef` | Reference to an `Agent` profile (`agentId`) |
| `agentAction` | `agentRun` | Batch agent execution column configured by `agentConfig` (`agentId?`, `promptTemplate`, `targetColumnId?`, `spawnIssueRepo?`); placeholders `{{column_id}}`, `{{Column Name}}`, `{{row_id}}` |
| `noteRef` | `noteRef` | Link to another `Note` (`noteId`); indexed into `note_link` |
| `formula` | computed | Pure Rust deterministic projection from `formula` expression; not stored in `row.cells` |

## All 8 `BaseCellValue` (`_tag`) Variants

Every cell in `BaseRow.cells` or `note_base_upsert_row` / `vv_base_upsert_row` MUST carry `_tag`:

```json
{ "_tag": "text", "value": "Summary text" }
{ "_tag": "number", "value": 42.5 }
{ "_tag": "bool", "value": true }
{ "_tag": "strings", "items": ["rust", "perf"] }
{ "_tag": "issueRef", "issueId": "i162" }
{ "_tag": "noteRef", "noteId": "note_01..." }
{ "_tag": "agentRef", "agentId": "backend" }
{
  "_tag": "agentRun",
  "status": "spawned",
  "summary": "Spawned issue #188",
  "sessionId": "s_01...",
  "spawnedIssueId": "i188",
  "updatedAt": 1732752000000
}
```

## All 4 `BaseViewKind`, 5 `BaseFilterOp`, and 5 `BaseSummaryOp` Values

- **`BaseViewKind` (`view.kind`)**: `table`, `board` (set `groupBy` to a `select` or `agentRef` column id), `gallery` (renders `media` or `pageNoteId` cover), `timeline` (renders `date` column).
- **`BaseFilterOp` (`filters[].op`)**: `eq`, `neq`, `contains`, `notEmpty`, `empty`. Every filter rule is `{ "columnId": "...", "op": "...", "value"?: "..." }`.
- **`BaseSummaryOp` (`summaries[].op`)**: `count`, `sum`, `avg`, `min`, `max`. Every summary config is `{ "columnId": "...", "op": "..." }`.
- **`BaseSortRule` (`sorts[]`)**: `{ "columnId": "...", "desc": true | false }`.

## Rust `Formula` Expression Syntax (`crates/core/src/note/base.rs`)

- **Column references**: `{column_id}` or `{Column Name}` (matched by id first, then exact name, then case-insensitive name).
- **Arithmetic**: `+`, `-`, `*`, `/`, unary `-`/`+`, parentheses `(...)`. Division by zero or invalid syntax safely returns `"—"` (never panics).
- **Comparisons & boolean logic**: `==` (or `=`), `!=` (or `<>`), `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`.
- **Built-in functions**:
  - `concat(a, b, ...)` — concatenates values as text.
  - `count(a, ...)` — counts non-empty scalars and list items.
  - `if(cond, thenExpr, elseExpr)` — conditional branch.
- **Literals**: numbers (`12.5`), strings (`"ok"` or `'ok'`), booleans (`true`, `false`).

Example formulas:

- `"{c_after} - {c_before}"`
- `"if({c_before} == 0, \"n/a\", ({c_before} - {c_after}) / {c_before})"`
- `"concat({Title}, \" (\", {c_delta}, \")\")"`
- `"count({Tags}, {c_note})"`

## Row = Page & Incremental Row Upsert

- Attach long evidence or sub-specs to a row by creating a child `doc` note (`parentId: <base_note_id>`) and linking its id in `BaseRow.pageNoteId` (indexed into `note_link`).
- Always mutate single rows incrementally via `note_base_upsert_row` / `vv_base_upsert_row` instead of rewriting the whole `structure/base.json`:

```json
{
  "id": "note_01...",
  "sheetId": "sheet1",
  "rowId": "r2",
  "cells": {
    "c_target": { "_tag": "text", "value": "crates/core/src/note/base.rs" },
    "c_verdict": { "_tag": "text", "value": "kept" },
    "c_before": { "_tag": "number", "value": 24 },
    "c_after": { "_tag": "number", "value": 18 }
  }
}
```

- Trigger batch agent execution via `note_base_run_agent_column` / `vv_base_run_agent_column`:

```json
{
  "id": "note_01...",
  "sheetId": "sheet1",
  "columnId": "c_action",
  "rowIds": ["r1", "r2"]
}
```
