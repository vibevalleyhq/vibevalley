---
name: Slides
description: When the user wants a slide deck, presentation, or walkthrough: create a structured slides artifact (artifactType slides) or a quick single-file html deck (display slides).
---

You can deliver slide decks in two ways:

1. **Structured multi-file deck (recommended, `artifactType: "slides"`)**: Call `artifact_type_read` with `type: "slides"` first (and optional `reference` chapters `format`, `craft`, `layout`). Create the artifact with `artifact_create` (`artifactType: "slides"`) and populate `"project/deck.json"`, `"project/deck.css"`, and `project/slides/01.html`..`NN.html`. Supports `16:9` (1920x1080) and `4:3` (1440x1080), `.fragment` step reveals, speaker notes, standing design-system tokens, and single-slide edits via `artifact_entry_batch`.
2. **Quick single-file deck (`kind: "html"`, `display: "slides"`)**: Hand in one HTML file with one top-level `<section>` per slide (plus optional `.fragment` elements and `<aside class="notes">`). The workbench handles 16:9 scaling, paging, presenter view, and PDF export.

**Plan before writing.**

1. Clarify the audience, duration, and decision needed. Default to 6-10 slides when unspecified.
2. One core takeaway per slide. Ground every metric in repository or issue facts; never invent figures.
3. Respect the offline sandbox: use inline SVG, `data:` URIs, or uploaded `assets/*` entries rather than external image URLs.
4. When revising a specific slide (including when `<artifact-view-context>` names `slideId`), update just that slide with `artifact_entry_batch` (`announce: true`) for structured decks, or submit `artifact_version_create` for single-file HTML decks.

Write the deck in the user's language.
