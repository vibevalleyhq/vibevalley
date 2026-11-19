# vibevalley-chart

Pure-Rust declarative data visualization and charting crate for VibeValley Markdown ```` ```chart ```` blocks, Artifact reports, and native GPUI views.

## Design

- **Zero runtime native/JS dependencies**: depends only on `serde`, `serde_json`, and `thiserror` (`#![forbid(unsafe_code)]`, zero `serde_json::Value`).
- **`resvg`-safe pure SVG**: emits clean `<svg>` using only inert geometric primitives and `<text>` (zero `<foreignObject>`, `<script>`, or event handlers). `ThemeMode::Resolved(ThemePalette)` defaults to VibeValley's warm workbench light/dark palettes with concrete hex colors and no CSS variables or `color-mix()`.
- **Chart families**: `bar` (vertical/horizontal, grouped/stacked/percentStacked), `line`, `area` (standard/stacked/percentStacked), `scatter`, `bubble`, `pie`, `donut`, `combo` (dual Y-axis), `heatmap` (sequential/diverging/custom ramp + WCAG contrast labels), `boxplot`, `histogram`, and `sparkline`.
- **Ergonomics**: accepts JSON and JSONC (`//`, `/* */`, trailing commas), Heckbert Nice-Number ticks, log/linear scales, 5 number formats (`number`, `compact`, `percent`, `currency`, `duration`), pluggable `TextMeasurer` with ASCII + CJK default metrics, smart X-axis label rotation/thinning, and line/band annotations.
