# motion: Deterministic Motion Film

`motion` (`body = "store"`, `artifactType: "motion"`) builds frame-accurate motion graphics, explainers, and kinetic typography with scrubbing, `-1f`/`+1f` frame stepping, chapter pills, and WebM video export into the Media Library.

## Entry Layout

- `film/meta` (JSON): `{ "width": 1280, "height": 720, "fps": 30, "duration": 6, "background": "#151413", "chapters": [{ "at": 0, "label": "Intro" }] }`
- `"modules/scenes.json"` (JSON) or `modules/*.js` (text): Scene timing tables or reusable drawing helpers.
- `film/script` (text): Defines `window.CUT = { duration, fps, chapters, setup(stage, kit), render(t, stage, kit) }`.

## Iron Rule: Pure Function of Time `t`

- `render(t, stage, kit)` must be a pure function of `t` (in seconds) with zero mutable frame-to-frame accumulators, so scrubbing and WebM recording produce identical frames.
- Prefer `<canvas>` or `<svg>` stages for crisp frame-by-frame WebM export (up to 60s).
- Quick single-file alternative: `artifact_create({ kind: "html", display: "motion" })` calling `vv.timeline(duration, renderAt)`.

Further references: `artifact_type_read({ type: "motion", reference: "film-api" | "choreography" })`.
