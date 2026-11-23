# docs: Collaborative Document

`docs` is for structured long-form writing edited together by humans and helpers (`body = "blocks"`, created via `artifact_create` with `artifactType: "docs"` or `kind: "markdown"`).

## Workflow

1. **Create**: `artifact_create({ title, artifactType: "docs", content })` seeds initial Markdown blocks, or omit `content` to start an empty block document.
2. **Surgical block edits (never rewrite whole documents)**:
   - Read current block IDs, hierarchy, and `rev` via `artifact_block_list({ id })` (and check `selectedBlockIds` in `<artifact-view-context>` when present).
   - Prefer `artifact_block_batch({ id, ops })` for multi-step `create` (supports `tempId` cross-references) / `update` (with `baseRev`) / `move` / `delete`; use `artifact_block_create`, `artifact_block_update`, or `artifact_block_delete` for single edits.
3. **Respect user-authored blocks**: Agent edits to blocks written by the user automatically become tracked suggestions for user approval.

## Native Visual & Interactive Blocks (`chart` / `genui`)

Code blocks in `docs` support two pure-native renderers (`type: "code"` with `language: "chart"` or `"genui"`, or fenced Markdown blocks):

- **Data charts (```` ```chart ````)**: JSON spec with `type` (`bar`, `line`, `area`, `scatter`, `bubble`, `pie`, `donut`, `combo`, `heatmap`, `boxplot`, `histogram`, `sparkline`), `categories`, `series`, and optional `xAxis`/`yAxis`/`legend`/`annotations`:
  ```json
  {"type":"bar","title":"Weekly Throughput","categories":["W1","W2","W3"],"series":[{"name":"Done","data":[6,9,12]}],"showValues":true}
  ```
- **Interactive declarative UI (```` ```genui ````)**: Ideal for calculators, scenario explorers, and compact dashboards. Top-level fields: `title`, `root_id`, `state`, `nodes` (`stack`/`grid`/`card`/`tabs` containers reference child IDs; `slider`/`switch`/`select`/`tabs` bind to `state`; `metric`/`text`/`badge`/`progress`/`callout`/`table`/`chart` react via `{"expr":"..."}` or `${expr}`):
  ```json
  {"title":"Cost Estimator","root_id":"root","state":{"seats":5,"price":20},"nodes":[{"id":"root","kind":"stack","gap":12,"children":["seats_in","total"]},{"id":"seats_in","kind":"slider","bind":"seats","label":"Seats","min":1,"max":50,"step":1},{"id":"total","kind":"metric","label":"Monthly Total","value":{"expr":"seats * price"},"format":"currency"}]}
  ```

## Craft

- **Lead with the decision**: Put the conclusion or recommendation in the opening paragraph.
- **Scannable rhythm**: Break sections with `heading` (levels 1–3), use `todo` for action items, `quote` for key callouts, and inline `` `code` `` for identifiers and paths.

Further reference: `artifact_type_read({ type: "docs", reference: "structure" })`.
