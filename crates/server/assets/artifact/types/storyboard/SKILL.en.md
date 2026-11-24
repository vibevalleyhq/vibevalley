# storyboard: Shot-by-Shot Production Script

`storyboard` structures visual framing, camera motion, generation prompts, dialogue/voiceover, SFX/music cues, and local reference media shot by shot—bridging upstream **media generation (image/audio)** directly into downstream **`motion`** films. Stored as a directory in `storage/` (`<storage>/artifact/<id>/`), the script lives in `structure/shots.json` with organized media under `asset/{frames,refs,audio}/`.

## Directory Layout

```text
<storage>/artifact/<id>/
├── manifest.json                 # id, artifactType: "storyboard", title, entry: "structure/shots.json"
├── structure/
│   └── shots.json                # Format specs, continuity style guide, and ordered shot list
└── asset/
    ├── frames/                   # Generated or sketched shot keyframes (asset/frames/sh01-key.png)
    ├── refs/                     # Character sheets, lighting & style refs (asset/refs/hero-sheet.png)
    └── audio/                    # Voiceover takes & SFX clips (asset/audio/sh01-vo.wav)
```

Minimal `structure/shots.json`:
```json
{
  "title": "VibeValley Launch Film",
  "aspectRatio": "16:9",
  "fps": 30,
  "styleGuide": {
    "visualTone": "Warm tactile studio desk, natural daylight, restrained neutrals",
    "palette": ["#fcfcfb", "#1c1917", "#4d7a2a", "#d97742"],
    "continuityRefs": ["asset/refs/palette-board.png"]
  },
  "shots": [
    {
      "id": "sh01",
      "scene": "Opening",
      "durationSec": 3.5,
      "framing": "wide",
      "camera": "slow push-in",
      "visual": "Top-down desk view as an artifact folder opens and live collaborator cursors appear",
      "prompt": "Warm editorial desk top-down shot, clean paper folders opening, soft morning sunlight",
      "dialogue": "Every artifact is a living directory built together by humans and agents.",
      "sfx": "Soft paper fold + warm marimba chord",
      "frameAsset": "asset/frames/sh01-key.png",
      "refAssets": ["asset/refs/palette-board.png"],
      "audioAsset": "asset/audio/sh01-vo.wav",
      "status": "ready"
    }
  ]
}
```

## Multi-Human & Multi-Agent Collaboration Rules

1. **Per-shot CRDT sync (`artifact_collab`)**: Each shot has a stable `id` (`sh01`, `sh02`...). Writers can polish dialogue while media agents attach `asset/frames/` keyframes and `asset/audio/` voiceover clips concurrently; `artifact_collab` merges field-level updates cleanly without rewriting the whole script.
2. **Origin-tracked cuts (`artifact_change`)**: Every reorder, timing tweak, prompt edit, and asset swap carries its `origin` for replay, undo-by-origin, and alternate-length forks (e.g., 30s teaser cut). Lock production scripts with `artifact_version`.
3. **Review suggestions (`artifact_suggestion`)**: Propose tracked suggestions before altering human-authored dialogue, pacing, or any shot marked `status: "locked"`.
4. **Live presence awareness**: Check which shot IDs collaborators currently focus on; generate prompts, frames, or audio on unoccupied shots in parallel.

## Bridging Media Generation & `motion`

- **Local asset discipline**: Save all generated keyframes, character/style references, and synthesized voiceovers into `asset/{frames,refs,audio}/` and bind them via relative paths.
- **Direct handoff to `motion`**: Once shots are locked, total duration equals `sum(shots[].durationSec)` and each shot maps 1:1 into a `motion` scene (`structure/scenes/<shotId>.json`) reusing the exact `asset/` files.

Further references: `artifact_type_read({ type: "storyboard", reference: "format" | "craft" })`.
