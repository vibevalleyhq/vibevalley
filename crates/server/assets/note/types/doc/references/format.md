# Doc JSON Format (`structure/doc.json`)

`structure/doc.json` stores a serialized `DocDocument` (`crates/protocol/src/contract/note.rs`):

```json
{
  "version": 1,
  "blocks": [
    {
      "id": "b1",
      "type": "heading",
      "level": 1,
      "text": "Architecture Overview"
    },
    {
      "id": "b2",
      "type": "prose",
      "text": "See [[note:note_01]] and #42 for context."
    }
  ]
}
```

## `DocBlock` Wrapper

Every block in `blocks` (or passed as `block` to `note_doc_append_block` / `vv_doc_append_block`) uses camelCase wire keys:

- `id` (`string`, required): stable block identifier (e.g. `"b1"`, `"b_kpi_1"`).
- `type` (`string`, required): one of the 24 `BlockKind` wire discriminators below; its variant fields are flattened at the top level of the block object.
- `collapsed` (`boolean`, optional): initial fold state (commonly `true` on `toggle` blocks holding long logs).
- `children` (`DocBlock[]`, optional): nested child blocks (e.g. indented `list` items or `toggle` body blocks).

Incremental append call shape (`note_doc_append_block` / `vv_doc_append_block`):

```json
{
  "id": "note_01...",
  "afterBlockId": "b2",
  "block": {
    "id": "b_kpi_1",
    "type": "kpi",
    "items": [
      { "label": "Lock Sites", "value": "92", "delta": "-39", "tone": "ok" }
    ]
  }
}
```

## All 24 `BlockKind` Contracts

### Basic (6)

| `type` | Required Fields | Optional Fields | Notes |
|---|---|---|---|
| `prose` | `text: string` | — | Paragraph; extracts `[[note:<id>]]`, `[[issue:<id>]]`, `#<num>` links |
| `heading` | `level: 1\|2\|3`, `text: string` | — | Drives `toc` and `NotePreview.Doc.outline` |
| `list` | `ordered: boolean`, `items: string[]` | — | Bullet or numbered list; nest via `children` |
| `todo` | `checked: boolean`, `text: string` | — | Checklist item; indexed into outline |
| `quote` | `text: string` | `attribution?: string` | Block quote with optional attribution |
| `divider` | — | — | Horizontal rule (`---`) |

```json
{ "id": "b_prose", "type": "prose", "text": "Linked to [[note:note_01]] and #162." }
```

```json
{ "id": "b_h2", "type": "heading", "level": 2, "text": "Key Findings" }
```

```json
{ "id": "b_list", "type": "list", "ordered": false, "items": ["Check [[issue:i162]]", "Run make verify-fast"] }
```

```json
{ "id": "b_todo", "type": "todo", "checked": true, "text": "Update doc/base format contracts" }
```

```json
{ "id": "b_quote", "type": "quote", "text": "Evidence first; drop unverified claims.", "attribution": "Engineering Governance" }
```

```json
{ "id": "b_div", "type": "divider" }
```

### Structure & Writing (9)

| `type` | Required Fields | Optional Fields | Notes |
|---|---|---|---|
| `toggle` | `title: string`, `text: string` | wrapper `collapsed?: boolean`, `children?: DocBlock[]` | Collapsible section; use `collapsed: true` for verbose build/test logs |
| `callout` | `tone: "info"\|"ok"\|"warn"\|"bad"`, `text: string` | `title?: string` | Highlighted banner; use at top for Attention / user decisions |
| `code` | `code: string` | `language?: string` | Syntax-highlighted code block; links are not extracted from code |
| `table` | `headers: string[]`, `rows: string[][]` | `alignments?: ("left"\|"center"\|"right")[]` | Simple static table; use `NoteType::Base` + `baseEmbed` for multi-view/formula datasets |
| `bookmark` | `url: string` | `title?: string`, `description?: string` | Rich external link card |
| `toc` | — | `maxLevel?: number` | Dynamic table of contents from `heading` blocks (default `1..=3`) |
| `math` | `expression: string` | `display?: boolean` | LaTeX math block (`display: true`) or inline formula |
| `columns` | `columns: { blocks: DocBlock[] }[]` | — | 2–4 side-by-side columns |
| `pageBreak` | — | `title?: string`, `speakerNotes?: string` | Slide boundary in Presenter Mode (`slideCount + 1`) |

```json
{
  "id": "b_toggle",
  "type": "toggle",
  "title": "Raw verification log (42 lines)",
  "text": "vp run docs:verify -> ok\nvp run scripts:test -> 100% pass",
  "collapsed": true
}
```

```json
{
  "id": "b_callout",
  "type": "callout",
  "tone": "warn",
  "title": "Attention: Decision Needed",
  "text": "Option A (Recommended): Keep HTTP v1 wire shape unchanged."
}
```

```json
{ "id": "b_code", "type": "code", "language": "bash", "code": "make verify-fast BASE=origin/main" }
```

```json
{
  "id": "b_table",
  "type": "table",
  "headers": ["Gate", "Result"],
  "rows": [["docs:verify", "pass"], ["scripts:test", "pass"]],
  "alignments": ["left", "right"]
}
```

```json
{
  "id": "b_bookmark",
  "type": "bookmark",
  "url": "https://vibevalley.dev",
  "title": "VibeValley",
  "description": "Local-first AI engineering workbench"
}
```

```json
{ "id": "b_toc", "type": "toc", "maxLevel": 3 }
```

```json
{ "id": "b_math", "type": "math", "expression": "S = \\frac{1}{(1 - p) + p / s}", "display": true }
```

```json
{
  "id": "b_cols",
  "type": "columns",
  "columns": [
    { "blocks": [{ "id": "b_c1", "type": "prose", "text": "Left summary" }] },
    { "blocks": [{ "id": "b_c2", "type": "prose", "text": "Right evidence" }] }
  ]
}
```

```json
{ "id": "b_slide", "type": "pageBreak", "title": "Benchmark Results", "speakerNotes": "Median of 5 interleaved release runs." }
```

### Data & VibeValley (9)

| `type` | Required Fields | Optional Fields | Notes |
|---|---|---|---|
| `kpi` | `items: { label, value, delta?, tone? }[]` | — | Tabular metric cards (`tone`: `info\|ok\|warn\|bad`) |
| `chart` | `kind: string`, `labels: string[]`, `series: { name: string, data: number[] }[]` | `title?: string` | Native `vv_chart` (`bar`, `line`, `area`, `pie`, `donut`, `scatter`, `combo`, `heatmap`, `sparkline`) |
| `diagram` | `source: string` | `title?: string` | Native Mermaid diagram (`flowchart`, `sequenceDiagram`, `stateDiagram-v2`, `classDiagram`, `erDiagram`) |
| `compare` | `beforeLabel`, `afterLabel`, `beforeAsset`, `afterAsset` (`string`) | `title?: string` | Visual before/after slider using relative `asset/...` paths |
| `media` | `mediaKind: "image"\|"audio"\|"video"`, `src: string` | `caption?: string` | Media embed pointing to `asset/...` or attachment URL |
| `preview` | `entry: string` | `height?: number`, `title?: string` | Sandboxed HTML preview pointing to `structure/...` (no `allow-same-origin`) |
| `baseEmbed` | `noteId: string` | `sheetId?: string`, `viewId?: string` | Embeds a live `NoteType::Base` view; writes `LinkRelation::Embed` edge |
| `issueCard` | `issueId: string` | — | Live single-issue status card; writes `LinkRelation::Embed` edge |
| `issueList` | — | `repo?: string`, `status?: string`, `tag?: string`, `limit?: number` | Live filtered issue list from `BoardSlice` |

```json
{
  "id": "b_kpi",
  "type": "kpi",
  "items": [
    { "label": "Kept Commits", "value": "6", "delta": "+6", "tone": "ok" },
    { "label": "Reverted", "value": "1", "delta": "0 net debt", "tone": "info" }
  ]
}
```

```json
{
  "id": "b_chart",
  "type": "chart",
  "title": "Latency (ms)",
  "kind": "bar",
  "labels": ["Baseline", "Candidate"],
  "series": [{ "name": "p50", "data": [48.2, 21.4] }]
}
```

```json
{
  "id": "b_diagram",
  "type": "diagram",
  "title": "Patrol Loop",
  "source": "flowchart LR\n  Sensors --> Hypothesis --> Gate --> Verdict"
}
```

```json
{
  "id": "b_compare",
  "type": "compare",
  "title": "Note Editor Dark Theme",
  "beforeLabel": "Before",
  "afterLabel": "After",
  "beforeAsset": "asset/before-dark.png",
  "afterAsset": "asset/after-dark.png"
}
```

```json
{
  "id": "b_media",
  "type": "media",
  "mediaKind": "image",
  "src": "asset/vdp-note-light.png",
  "caption": "VDP verification screenshot"
}
```

```json
{
  "id": "b_preview",
  "type": "preview",
  "entry": "structure/demo.html",
  "height": 360,
  "title": "Interactive Prototype"
}
```

```json
{
  "id": "b_base",
  "type": "baseEmbed",
  "noteId": "note_01a21e90b89a721e910540c4bcf86f44",
  "sheetId": "sheet1",
  "viewId": "v_board"
}
```

```json
{ "id": "b_issue", "type": "issueCard", "issueId": "i162" }
```

```json
{ "id": "b_issues", "type": "issueList", "repo": "vibevalley", "status": "in_progress", "tag": "Note", "limit": 10 }
```
