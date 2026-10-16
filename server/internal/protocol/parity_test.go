package protocol

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Reduce, effects, the view and the inbox, fact by fact, against testdata/parity.jsonl.gz: runs of facts, each from an empty farm.
func TestReduceGolden(t *testing.T) {
	cases := readCases(t, "testdata/parity.jsonl.gz")
	run, line := -1, 0
	state := EmptyFarm()
	for _, body := range cases.lines {
		line++
		cases.begin(line)
		var row struct {
			Run     int             `json:"run"`
			Fact    Fact            `json:"fact"`
			Changed bool            `json:"changed"`
			State   json.RawMessage `json:"state"`
			Effects json.RawMessage `json:"effects"`
			View    json.RawMessage `json:"view"`
			Inbox   json.RawMessage `json:"inbox"`
		}
		if err := json.Unmarshal(body, &row); err != nil {
			t.Fatalf("line %d: %v", line, err)
		}
		if row.Run != run {
			run, state = row.Run, EmptyFarm()
		}
		effects := EffectsOf(state, row.Fact)
		next, changed := Reduce(state, row.Fact)
		if !recorded(changed, "changed") && changed != row.Changed {
			t.Fatalf("line %d (%T): changed %v, want %v", line, row.Fact.Value, changed, row.Changed)
		}
		sameJSON(t, line, "state", next, row.State)
		if effects == nil {
			effects = []GameEffect{}
		}
		sameJSON(t, line, "effects", effects, row.Effects)
		sameJSON(t, line, "view", ViewOf(next), row.View)
		sameJSON(t, line, "inbox", Inbox(next), row.Inbox)
		state = next
		cases.end()
	}
	cases.close()
	if line < 1000 {
		t.Fatalf("only %d facts", line)
	}
}

// sameJSON compares got, as JSON, with the case's part what (or records it there, with -update).
func sameJSON(t *testing.T, line int, what string, got any, want json.RawMessage) {
	t.Helper()
	if recorded(got, what) {
		return
	}
	body, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("line %d %s: %v", line, what, err)
	}
	var a, b any
	_ = json.Unmarshal(body, &a)
	_ = json.Unmarshal(want, &b)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("line %d %s:\n got %s\nwant %s", line, what, body, want)
	}
}
