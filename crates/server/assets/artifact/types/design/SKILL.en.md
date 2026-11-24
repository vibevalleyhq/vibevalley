# design: Multi-Artboard UI & Visual Mockups

`design` organizes multi-screen UI mockups, responsive viewports, and edge-case states on a visual canvas with optional `design-system` token linking and live adjustable `props` levers. Each design artifact is stored as a directory in `storage/` (`<storage>/artifact/<id>/`).

## Directory Layout

```text
<storage>/artifact/<id>/
├── manifest.json                 # id, artifactType: "design", title, optional designSystemId, frames list
├── structure/
│   └── frames/
│       ├── desktop-checkout.json # Desktop artboard: position, size, node tree, variants, live props
│       ├── mobile-checkout.json  # Mobile artboard
│       └── empty-state.json      # Edge-case artboard
└── asset/
    └── hero-product.png          # Local imagery referenced via asset/<name>
```

Example `manifest.json`:
```json
{
  "id": "art_design_01",
  "artifactType": "design",
  "title": "Checkout Multi-Viewport Design",
  "designSystemId": "art_ds_default",
  "frames": [
    "structure/frames/desktop-checkout.json",
    "structure/frames/mobile-checkout.json"
  ]
}
```

## Multi-Human & Multi-Agent Collaboration Rules

1. **Per-frame CRDT sync (`artifact_collab`)**: Each artboard lives in its own `structure/frames/<id>.json` so humans and agents can work on desktop, mobile, and edge states concurrently. `artifact_collab` merges node-level edits by stable `id` without clobbering sibling frames.
2. **Origin-tracked iterations (`artifact_change`)**: Every visual edit records its `origin` for review replay, undo-by-origin, and option forks; snapshot signed-off milestones with `artifact_version`.
3. **Review suggestions (`artifact_suggestion`)**: Propose tracked suggestions when revising human-tuned copy, spacing, or palette tokens—or add a side-by-side comparison frame rather than overwriting their artboard.
4. **Live presence awareness**: Check active artboard focus and selected layer IDs before editing; parallelize on unoccupied viewports or states first.

## Tokens & Craft

- **Bind to `design-system`**: When `designSystemId` (or a default design system) is present, reference semantic tokens (`{color.surface}`, `{radius.md}`, `{space.4}`) instead of ad-hoc hex values.
- **Live `props` levers**: Declare interactive controls (`density`, `theme`, `ctaLabel`) inside each frame's `props` so reviewers can test variations directly.
- **Realistic copy & edge states**: Use domain-accurate text and metrics (never `Lorem ipsum`), and include empty/loading/error frames alongside the happy path.

Further references: `artifact_type_read({ type: "design", reference: "format" | "craft" })`.
