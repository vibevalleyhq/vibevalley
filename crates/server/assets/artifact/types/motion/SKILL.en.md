# motion: Deterministic Motion Film

`motion` builds frame-accurate motion graphics, product reveals, algorithm explainers, and kinetic typography with timeline scrubbing, frame stepping (`-1f`/`+1f`), chapters, and video export to the media library. Each project is stored as a directory in `storage/` (`<storage>/artifact/<id>/`).

## Directory Layout

```text
<storage>/artifact/<id>/
├── manifest.json                 # id, artifactType: "motion", title, entry: "structure/timeline.json"
├── structure/
│   ├── timeline.json             # Resolution, fps, duration, chapters, audio tracks, scene schedule
│   └── scenes/
│       ├── sc01-intro.json       # Scene layers, keyframes, easing curves, and captions
│       └── sc02-reveal.json
└── asset/
    ├── audio/                    # Voiceover, BGM, SFX (asset/audio/vo-01.wav)
    ├── video/                    # Screen captures or footage (asset/video/demo.mp4)
    └── image/                    # Sprites, logos, reference art (asset/image/logo.svg)
```

Example `structure/timeline.json`:
```json
{
  "title": "Release Opener",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "duration": 12.0,
  "background": "#151413",
  "chapters": [{ "at": 0, "label": "Intro" }, { "at": 4.5, "label": "Reveal" }],
  "scenes": [
    { "id": "sc01-intro", "file": "structure/scenes/sc01-intro.json", "start": 0, "end": 4.5 },
    { "id": "sc02-reveal", "file": "structure/scenes/sc02-reveal.json", "start": 4.5, "end": 12.0 }
  ],
  "audioTracks": [{ "id": "bgm", "src": "asset/audio/bgm.wav", "start": 0, "gain": 0.35 }]
}
```

## Multi-Human & Multi-Agent Collaboration Rules

1. **Per-scene CRDT sync (`artifact_collab`)**: Split scenes into `structure/scenes/<id>.json` so humans and agents can refine different scenes simultaneously. `artifact_collab` merges timeline and layer mutations conflict-free and syncs back to disk.
2. **Origin-tracked cuts (`artifact_change`)**: Every timing, keyframe, and audio-track change carries its `origin` for timeline preview, undo-by-origin, and alternate-cut forks; freeze render cuts with `artifact_version`.
3. **Review suggestions (`artifact_suggestion`)**: Propose tracked suggestions before altering human-tuned timing, copy, or transitions.
4. **Live presence awareness**: Respect active playhead positions and selected scenes; parallelize across unoccupied scenes or audio tracks.

## Iron Rule: Pure Function of Time `t`

- **Frame determinism**: Any timestamp `t` (in seconds) must always render the exact same frame—never use frame-to-frame mutable accumulators (`x += vx`) or unseeded randomness, so scrubbing and export match byte-for-byte.
- **Bridge from `storyboard`**: For narrated or multi-shot films, lock shot beats and assets in a `storyboard` first, then map shots into `motion` scenes and `asset/{audio,video,image}/`.

Further references: `artifact_type_read({ type: "motion", reference: "film-api" | "choreography" })`.
