# Media JSON Format (`structure/media.json`)

`structure/media.json` organizes audio/video recordings, generated images/speech, transcripts, storyboards, and motion clips inside `<storage>/note/<id>/`. Binary assets live under `asset/{audio,video,image}/`.

## Audio / Video / Image Collection Example

```json
{
  "version": 1,
  "title": "Kickoff Sync",
  "mediaKind": "audio",
  "caption": "Weekly architecture sync recording and transcript",
  "durationSec": 184.5,
  "posterAsset": "asset/image/poster.png",
  "issueId": "i162",
  "items": [
    {
      "id": "m1",
      "kind": "audio",
      "src": "asset/audio/recording.wav",
      "title": "Kickoff Sync",
      "caption": "Main room audio track",
      "durationSec": 184.5,
      "issueId": "i162",
      "jobId": "job_01...",
      "transcriptExcerpt": "Reviewing the Note 3+1 workspace primitives.",
      "transcript": [
        {
          "id": "cue-1",
          "startSec": 0,
          "endSec": 12.4,
          "speaker": "Ada",
          "text": "Reviewing the Note 3+1 workspace primitives."
        }
      ]
    }
  ]
}
```

## Top-Level Fields

| Field | Type | Required | Purpose |
|---|---|---|---|
| `version` | `1` | yes | Schema version |
| `title` | `string` | yes | Display title |
| `mediaKind` | `"audio"\|"video"\|"image"\|"storyboard"\|"motion"` | yes | Primary media mode; surfaced in `NotePreview.Media.mediaKind` |
| `caption` | `string` | no | Short description (up to 160 chars shown in card preview) |
| `durationSec` | `number \| null` | no | Total duration in seconds |
| `posterAsset` | `string \| null` | no | Relative `asset/image/...` raster thumbnail (`png`/`jpg`/`webp`/`gif`) used for card preview |
| `issueId` | `string` | no | Optional linked issue id |
| `items` | `MediaItem[]` | no | Ordered media clips with optional per-item transcripts |
| `transcript` | `TranscriptCue[] \| string` | no | Optional top-level transcript cues |
| `transcriptExcerpt` | `string` | no | Short summary shown above full cue list |

## `MediaItem` & `TranscriptCue` Fields

- `MediaItem`: `id`, `kind` (`"audio"|"video"|"image"`), `src` (`asset/...` or attachment URL), `title`, `caption?`, `durationSec?`, `issueId?`, `jobId?`, `transcript?: TranscriptCue[]`, `transcriptExcerpt?`.
- `TranscriptCue`: `id`, `startSec` (number), `endSec` (number), `speaker` (string), `text` (string).

## Optional Storyboard & Motion Fields

When authoring a storyboard (`mediaKind: "storyboard"`):

```json
{
  "version": 1,
  "title": "Launch Trailer Storyboard",
  "mediaKind": "storyboard",
  "aspectRatio": "16:9",
  "fps": 24,
  "styleGuide": { "visualTone": "Warm handcrafted papercraft", "palette": ["#F7F3EB", "#B84A39"] },
  "shots": [
    {
      "id": "s1",
      "scene": "Opening Courtyard",
      "durationSec": 4,
      "framing": "Wide",
      "camera": "Slow dolly in",
      "visual": "Paper farmhouse unfolding at sunrise",
      "dialogue": "",
      "sfx": "Soft cardstock fold",
      "transitionOut": "Cut",
      "status": "draft"
    }
  ]
}
```

When authoring a motion clip (`mediaKind: "motion"`):

```json
{
  "version": 1,
  "title": "Feature Walkthrough Clip",
  "mediaKind": "motion",
  "width": 1280,
  "height": 720,
  "fps": 30,
  "duration": 12,
  "background": "#F7F3EB",
  "chapters": [{ "id": "ch1", "title": "Intro", "start": 0 }],
  "scenes": [
    {
      "id": "sc1",
      "file": "structure/scene-1.json",
      "start": 0,
      "end": 6,
      "title": "Base Multi-View",
      "layers": [{ "id": "l1", "label": "Title", "text": "Note 3+1 Primitives", "opacity": 1 }]
    }
  ]
}
```
