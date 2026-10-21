# @vibevalley/engine

A 2.5D pixel game framework with no farm in it: no `@vibevalley/protocol`, no React. The farm (`apps/web/src/farm`)
draws with it.

| Entry | What |
|---|---|
| `@vibevalley/engine/pixi` | `pixelStage` (the scene drawn at its true size into a texture, shown scaled by a whole number; `frame` places it as the caller frames it), `Walker`, `frameAt`, `swayCamera`, `leanToPointer`; particles, critters, `cadence`/`gust`, the light (`pixelLighting`, normal maps, `skyAt`), `materialOf`, the canvas ui (`card`, `hitRegion`) |
| `@vibevalley/engine/nav` | `navMap`: grid A* that keeps off edges, then cuts corners |
| `@vibevalley/engine/audio` | `createSynth`, `renderRecipe`, `toWav`, `measure`: sound effects synthesized in Web Audio |
| `@vibevalley/engine/clock` | `dayClock` (advanced by whoever owns the frame), `sunOf`, `duskOf`, `clockText` |

```bash
bun run check   # types
bun run test    # vitest: nav, clock, rhythm, light
```
