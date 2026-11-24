# dashboard: Verifiable Data Dashboard

`dashboard` strictly separates structured datasets from KPI and chart layout so every displayed figure is computed from source rows and auditable down to the field level. Each dashboard is stored as a directory in `storage/` (`<storage>/artifact/<id>/`).

## Directory Layout

```text
<storage>/artifact/<id>/
├── manifest.json               # id, artifactType: "dashboard", title, entry: "structure/dashboard.json"
├── structure/
│   ├── dashboard.json          # Filters, KPI cards, charts, tables, and provenance bindings
│   └── data/
│       ├── revenue.json        # Structured row dataset (rows + schema + source metadata)
│       └── funnel.json
└── asset/
    └── raw-export.csv          # Optional raw CSV source or methodology chart via asset/<name>
```

Minimal `structure/dashboard.json`:
```json
{
  "title": "Q3 Revenue Dashboard",
  "filters": [{ "id": "region", "label": "Region", "type": "select", "options": ["all", "East", "West"], "default": "all" }],
  "panels": [
    {
      "id": "kpi_rev",
      "kind": "kpi",
      "label": "Total Revenue",
      "source": { "dataset": "structure/data/revenue.json", "field": "revenue", "agg": "sum" },
      "format": "currency"
    },
    {
      "id": "trend_rev",
      "kind": "chart",
      "chartType": "line",
      "source": { "dataset": "structure/data/revenue.json", "x": "month", "y": "revenue", "seriesBy": "region" }
    }
  ]
}
```

## Multi-Human & Multi-Agent Collaboration Rules

1. **Decoupled CRDT sync (`artifact_collab`)**: Keep raw data in `structure/data/*.json` and visual definitions in `structure/dashboard.json`. `artifact_collab` merges concurrent dataset refreshes and panel edits by stable `id` without clobbering unrelated panels.
2. **Origin-tracked provenance (`artifact_change`)**: Every dataset refresh and formula edit is attributed via `origin`, supporting timeline diffing and undo-by-origin for bad imports. Freeze reporting cuts with immutable `artifact_version` snapshots.
3. **Metric-change suggestions (`artifact_suggestion`)**: When changing user-authored KPI definitions, aggregation formulas, or removing panels, submit an `artifact_suggestion` for human approval.
4. **Live presence awareness**: Check focused panel IDs and dataset editors before modifying layout; never overwrite shared `filters[].default` while a human is exploring slices.

## Mandatory Provenance Rules

- **Zero hardcoded mental math**: Every KPI and chart series must bind via `source` (`dataset`, `field`, `agg`) to `structure/data/*.json` so the Workbench verifies every rendered number against source rows.
- **Explicit metadata & empty states**: Include `schema` and `updatedAt` in each dataset file and handle zero-row filtered states cleanly.

Further references: `artifact_type_read({ type: "dashboard", reference: "features" | "design-defaults" })`.
