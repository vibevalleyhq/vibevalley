# Media JSON Format (`structure/media.json`)

```json
{
  "version": 1,
  "title": "Kickoff Sync",
  "mediaKind": "audio",
  "caption": "Weekly architecture sync recording and transcript",
  "durationSec": 184.5,
  "posterAsset": "asset/image/poster.png",
  "items": [
    {
      "id": "m1",
      "kind": "audio",
      "src": "asset/audio/recording.wav",
      "title": "Kickoff Sync",
      "caption": "Main room audio track",
      "durationSec": 184.5,
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
