# @vibevalley/engine

A 2.5D pixel game framework with no farm in it: no `@vibevalley/protocol`, no React. The farm (`apps/web/src/farm`)
draws with it.

| Entry | What |
|---|---|
| `@vibevalley/engine/pixi` | `pixelStage` (the scene drawn at its true size into a texture, shown scaled by a whole number; `frame` places it as the caller frames it), `Walker`, `frameAt`, `leanToPointer`; particles, critters, `cadence`/`gust`, the light (`pixelLighting`, normal maps, `skyAt`), `materialOf` |
| `@vibevalley/engine/nav` | `navMap`: grid A* that keeps off edges, then cuts corners |
| `@vibevalley/engine/audio` | `createSynth`: sound effects synthesized in Web Audio |
| `@vibevalley/engine/framing` | `frameWhole` (a picture in a view at a whole scale, cutting at most so much off each side), `fills`, `filledNear` (the nearest view of the same shape it fills) |
| `@vibevalley/engine/clock` | `dayClock` (advanced by whoever owns the frame), `sunOf`, `duskOf`, `clockText` |

```bash
vp run test     # vitest: nav, clock, rhythm, light, framing (types: vp check at the root)
```
