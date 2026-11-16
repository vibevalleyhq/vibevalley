# dashboard: Verifiable Data Dashboard

`dashboard` (`body = "store"`, `artifactType: "dashboard"`) separates structured datasets from visual presentation and verifies displayed figures against source rows in real time.

## Entry Layout

- `datasets/<id>` (JSON): Array of row objects (e.g. `[{"quarter":"Q1","revenue":120000}]`).
- `dash/params` (JSON): Persisted filter parameters (e.g. `{"quarter":"all"}`).
- `files/index.html` (text): Dashboard markup and script using the injected `window.dash` runtime.

## Mandatory Provenance & Runtime Rules

1. **Never hardcode mental math**: Compute every KPI and chart series from `dash.data("<id>")` and `dash.calc` (`sum`, `avg`, `min`, `max`, `median`, `count`, `groupBy`, `pctChange`, `formatNumber`, `formatCurrency`, `formatPct`).
2. **Tag KPI elements with `[data-source]`**:
   ```html
   <span id="rev" data-source="metrics" data-field="revenue" data-agg="sum"></span>
   ```
   Call `dash.scan()` after rendering so the Workbench Sources drawer verifies every figure.
3. **Reactive updates**: Register `dash.onData(draw)` and `dash.onParams(draw)`, and persist filter changes via `dash.setParams(patch)`.

Further references: `artifact_type_read({ type: "dashboard", reference: "features" | "design-defaults" })`.
