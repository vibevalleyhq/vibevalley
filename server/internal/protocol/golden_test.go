package protocol

// The protocol's golden files (internal/golden): testdata/*.jsonl.gz, the fold's and the shared rules' cases; and the client's
// state-frame.sample.json, a frame as this encoder writes it, for the Flutter client's decoding test.

import (
	"encoding/json"
	"testing"

	"vibevalley/internal/golden"
)

const sampleState = `{
  "call": "live", "manager": "speaking", "reports": [],
  "sessions": [{
    "id": "w1", "name": "Pi 实验员", "agent": "lab", "runtime": "pi", "task": "写打卡", "hiredAt": 1, "runs": 1,
    "phase": {"_tag": "working", "since": 2, "doing": {"action": "edit_file", "label": "改 checkin.ts"}},
    "play": {
      "station": 2, "history": [{"at": 2, "action": "edit_file", "label": "src/checkin.ts"}], "toolsThisRun": 1,
      "counts": {"edit_file": 1}, "files": ["src/checkin.ts"], "commands": [], "runStartedAt": 2
    }
  }],
  "chat": {
    "conversations": [{"id": "c1", "kind": "general", "replies": 0, "at": 1}],
    "messages": [
      {"id": "m1", "number": 1, "conversation": "c1", "from": "user", "fromKind": "user", "name": "主人", "kind": "chat", "text": "让 Pi 实验员写打卡", "final": true, "at": 1},
      {"id": "m2", "number": 2, "conversation": "c1", "from": "manager", "fromKind": "manager", "name": "管家", "kind": "chat", "text": "好，派给 Pi 实验员了", "final": false, "at": 2}
    ]
  }
}`

func TestStateFrameSample(t *testing.T) {
	var frame StateFrame
	if err := json.Unmarshal([]byte(`{"state": `+sampleState+`, "view": {}, "effects": [{"kind": "levelUp", "level": 2}]}`), &frame); err != nil {
		t.Fatal(err)
	}
	frame = FrameOf(frame.State, frame.Effects)
	golden.File(t, "../../../app/test/fixtures/state-frame.sample.json", golden.Indented(t, frame))
}
