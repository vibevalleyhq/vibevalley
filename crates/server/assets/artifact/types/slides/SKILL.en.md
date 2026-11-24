# slides: Structured Slide Deck

`slides` represents multi-slide presentation decks supporting per-slide collaborative editing, step-by-step fragments, presenter notes, and vector PDF export. Stored as a directory in `storage/` (`<storage>/artifact/<id>/`), the deck index lives in `structure/deck.json`, each slide in `structure/slides/*.json`, and media in `asset/`.

## Directory Layout

```text
<storage>/artifact/<id>/
├── manifest.json             # id, artifactType: "slides", title, entry: "structure/deck.json"
├── structure/
│   ├── deck.json             # Aspect ratio, optional designSystemId, ordered slide list
│   └── slides/
│       ├── s01-cover.json    # Single-slide layout, blocks, fragments, and speaker notes
│       └── s02-kpi.json
└── asset/
    └── hero-arch.png         # Referenced via relative path: asset/hero-arch.png
```

Example `structure/deck.json`:
```json
{
  "title": "Quarterly Product Launch",
  "aspectRatio": "16:9",
  "designSystemId": null,
  "slides": [
    { "id": "s01-cover", "file": "structure/slides/s01-cover.json", "title": "Cover" },
    { "id": "s02-kpi", "file": "structure/slides/s02-kpi.json", "title": "Key Metrics" }
  ]
}
```

## Multi-Human & Multi-Agent Collaboration Rules

1. **Per-slide isolation & CRDT sync (`artifact_collab`)**: Because each slide has its own file under `structure/slides/*.json`, humans and multiple agents can edit different slides concurrently while `artifact_collab` merges deck ordering and per-slide edits cleanly. Never rewrite untouched slides.
2. **Origin-tracked changes (`artifact_change`)**: Every slide edit and reorder records its `origin` for timeline inspection, undo-by-origin, and audience forks; snapshot milestone decks with `artifact_version`.
3. **Review suggestions (`artifact_suggestion`)**: Propose tracked suggestions when changing human-authored headlines, talking points, or speaker notes instead of silently overwriting them.
4. **Live presence awareness**: Check which slide IDs humans or peer agents currently focus on; parallelize across unoccupied slides first.

## Craft Rules

- **Headline as takeaway**: Every slide title states the conclusion so skimming titles tells the entire story.
- **One idea per slide, varied rhythm**: Never repeat the same bullet template back-to-back; alternate hero statements, KPI grids, two-column comparisons, visual diagrams, and closing summaries.
- **Zero overflow & progressive reveal**: Fit strictly inside `1920×1080` (`16:9`) or `1440×1080` (`4:3`) margins (≤ 5 bullets per slide); mark stepped items with `fragment: true`.
- **Assets & tokens**: Place images/fonts in `asset/` with relative paths; inherit tokens when linked to a `design-system`.

Further references: `artifact_type_read({ type: "slides", reference: "format" | "craft" | "layout" })`.
