package voyage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Ported from tests/cli-voyage.test.ts (the voyage-format assertions).

const requestJSON = `{"sessionId":"s-1","agentPath":[],"seq":2,"receivedAt":1050,"kind":"request","id":"rq-1","direction":"toRuntime","body":{"kind":"prompt","input":"hi"}}`
const eventJSON = `{"sessionId":"s-1","agentPath":["a1"],"seq":3,"receivedAt":1100,"kind":"frame","body":{"type":"assistant","native":{"type":"assistant"},"events":[{"kind":"text_delta","text":"hello"}]}}`

func decodeRecord(t *testing.T, raw string) oar.RawEvent {
	t.Helper()
	var record oar.RawEvent
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		t.Fatal(err)
	}
	return record
}

func parsed(t *testing.T, raw string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestHeaderLinePinsShape(t *testing.T) {
	got := HeaderLine(Header{Runtime: "claude", Model: "opus", Cwd: "/work", SessionID: "s-1", StartedAt: 1000, Recorder: "oar-cli/0.0.5"})
	want := `{"kind":"header","format":"oar-voyage/3","runtime":"claude","model":"opus","cwd":"/work","sessionId":"s-1","startedAt":1000,"recorder":"oar-cli/0.0.5"}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestHeaderLineEffortAfterModelAndOmittedWhenNone(t *testing.T) {
	got := HeaderLine(Header{Runtime: "codex", Model: "gpt-5.5", Effort: "low", Cwd: "/work", SessionID: "t-1", StartedAt: 1000, Recorder: "oar-cli/0.7.0"})
	want := `{"kind":"header","format":"oar-voyage/3","runtime":"codex","model":"gpt-5.5","effort":"low","cwd":"/work","sessionId":"t-1","startedAt":1000,"recorder":"oar-cli/0.7.0"}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	line := HeaderLine(Header{Runtime: "codex", Cwd: "/work", SessionID: "t-2", StartedAt: 1000, Recorder: "oar-cli/0.7.0"})
	if strings.Contains(line, "effort") {
		t.Fatalf("effort key must be absent: %s", line)
	}
}

func TestHeaderLineOmitsModel(t *testing.T) {
	line := HeaderLine(Header{Runtime: "codex", Cwd: "/work", SessionID: "s-2", StartedAt: 1000, Recorder: "oar-cli/0.0.5"})
	if strings.Contains(line, "model") {
		t.Fatalf("model key must be absent: %s", line)
	}
}

func TestEndLinePinsShape(t *testing.T) {
	if got := EndLine(2000, "disposed"); got != `{"kind":"end","at":2000,"reason":"disposed"}` {
		t.Fatal(got)
	}
}

func TestRecordLineWrapsVerbatim(t *testing.T) {
	for _, raw := range []string{eventJSON, requestJSON} {
		got := parsed(t, RecordLine(decodeRecord(t, raw)))
		want := map[string]any{"kind": "record", "record": parsed(t, raw)}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v\nwant %v", got, want)
		}
	}
}

func TestOpenWritesHeaderRecordsEndInOrder(t *testing.T) {
	previous := now
	t.Cleanup(func() { now = previous })
	now = func() int64 { return 9000 }
	path := filepath.Join(t.TempDir(), "run.jsonl")
	header := Header{Runtime: "claude", Cwd: "/work", SessionID: "s-1", StartedAt: 5000, Recorder: "oar-cli/0.0.5"}
	recorder, err := Open(path, header)
	if err != nil {
		t.Fatal(err)
	}
	request, event := decodeRecord(t, requestJSON), decodeRecord(t, eventJSON)
	if err := recorder.Record(request); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Record(event); err != nil {
		t.Fatal(err)
	}
	if err := recorder.End("disposed"); err != nil {
		t.Fatal(err)
	}
	if err := recorder.End("again"); err != nil {
		t.Fatalf("a second End is a no-op: %v", err)
	}
	if err := recorder.Record(event); err != ErrEnded {
		t.Fatalf("record after end = %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{HeaderLine(header), RecordLine(request), RecordLine(event), EndLine(9000, "disposed"), ""}
	if got := strings.Split(string(data), "\n"); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	records, err := ReadRecords(file)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 || records[0].ID != "rq-1" || records[1].Seq != 3 {
		t.Fatalf("records = %+v", records)
	}
}

func TestHeaderKeepsRequestedTier(t *testing.T) {
	header := parsed(t, HeaderLine(Header{Runtime: "codex", ServiceTier: "priority", Cwd: "/work", SessionID: "t", StartedAt: 0, Recorder: "test"})).(map[string]any)
	if header["serviceTier"] != "priority" {
		t.Fatalf("header = %v", header)
	}
}
