# sheet: Multi-Sheet Workbooks & Datasets

`sheet` models structured multi-table spreadsheets, financial models, comparison matrices, trackers, and curated datasets. Stored as a directory in `storage/` (`<storage>/artifact/<id>/`), workbook metadata lives in `structure/workbook.json`, each sheet in `structure/sheets/*.json`, and raw or exported tabular files in `asset/*.csv`.

## Directory Layout

```text
<storage>/artifact/<id>/
├── manifest.json                 # id, artifactType: "sheet", title, entry: "structure/workbook.json"
├── structure/
│   ├── workbook.json             # Ordered sheets, named ranges, locale/currency, validation rules
│   └── sheets/
│       ├── summary.json          # Summary sheet (cross-sheet formulas, frozen panes, formatting)
│       └── q3-budget.json        # Detail sheet (typed columns + row/cell values and formulas)
└── asset/
    └── raw-transactions.csv      # Raw CSV source or export snapshot via asset/<name>.csv
```

Example `structure/workbook.json`:
```json
{
  "title": "Q3 Engineering Budget",
  "locale": "en-US",
  "currency": "USD",
  "sheets": [
    { "id": "summary", "title": "Summary", "file": "structure/sheets/summary.json" },
    { "id": "q3-budget", "title": "Q3 Detail", "file": "structure/sheets/q3-budget.json" }
  ],
  "namedRanges": { "TotalBudget": "q3-budget!D2:D25" }
}
```

## Multi-Human & Multi-Agent Collaboration Rules

1. **Cell-level CRDT sync (`artifact_collab`)**: Per-sheet files and stable row/column keys let humans and agents edit different sheets or cells concurrently. `artifact_collab` merges cell updates conflict-free and materializes them to disk—never rewrite an entire sheet to change a few cells.
2. **Origin-tracked audit (`artifact_change`)**: Every cell edit, formula update, and import carries its `origin` for audit replay, undo-by-origin, and scenario forks; lock reporting milestones with `artifact_version`.
3. **Review suggestions (`artifact_suggestion`)**: Propose tracked suggestions before modifying human-entered assumptions, formulas, or deleting rows, clearly stating old value, new value, and downstream impact.
4. **Live presence awareness**: Check active sheet and selected cell ranges before editing; avoid typing into cells currently held by a human.

## Modeling Iron Rules

- **Formulas over mental math**: Keep raw inputs separate from computed totals/ratios; write explicit formulas (`=SUM(D2:D25)`, `=IFERROR((C2-B2)/B2, 0)`) instead of pasting hardcoded computed numbers.
- **Strict column typing**: Store numbers as native JSON `number` (formatting belongs to column `format`), dates as ISO-8601 (`YYYY-MM-DD`), and archive raw CSV imports in `asset/*.csv` with `sourceAsset` provenance.

Further references: `artifact_type_read({ type: "sheet", reference: "format" | "craft" })`.
