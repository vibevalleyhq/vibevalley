package protocol

// The golden files the protocol package keeps: compared on every run, written again with -update (go test
// ./internal/protocol -update) when a rule or a shape changed on purpose. testdata/*.jsonl.gz are the rules' cases,
// seeded random inputs with what the rules make of them. Two files are the client's: site-frame.sample.json, a frame as this encoder writes it, for the Flutter
// client's decoding test, and recall.sample.json, Pick's cases for the client's port of it (recall_sample_test.go).

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"flag"
	"os"
	"testing"
)

var update = flag.Bool("update", false, "write the golden files again from what the Go rules make now")

func golden(t *testing.T, path string, body []byte) {
	t.Helper()
	if *update {
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(body, want) {
		t.Fatalf("%s is stale: go test ./internal/protocol -update", path)
	}
}

func indented(t *testing.T, v any) []byte {
	t.Helper()
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// Each case's expected parts are compared with what the Go rules make; with -update, set replaces them, and close writes the file back.
type goldenCases struct {
	t     *testing.T
	path  string
	lines [][]byte
	out   [][]byte
	cur   any
}

var recording *goldenCases

func readCases(t *testing.T, path string) *goldenCases {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	unzipped, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(unzipped)
	scanner.Buffer(make([]byte, 0, 1<<20), 1<<26)
	g := &goldenCases{t: t, path: path}
	for scanner.Scan() {
		g.lines = append(g.lines, bytes.Clone(scanner.Bytes()))
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	recording = g
	t.Cleanup(func() { recording = nil })
	return g
}

func decodeLoose(body []byte) any {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	_ = dec.Decode(&v)
	return v
}

func (g *goldenCases) begin(line int) {
	if *update {
		g.cur = decodeLoose(g.lines[line-1])
	}
}

func (g *goldenCases) end() {
	if *update {
		body, err := json.Marshal(g.cur)
		if err != nil {
			g.t.Fatal(err)
		}
		g.out = append(g.out, body)
	}
}

func (g *goldenCases) set(got any, path ...any) {
	body, err := json.Marshal(got)
	if err != nil {
		g.t.Fatal(err)
	}
	value := decodeLoose(body)
	if len(path) == 0 {
		g.cur = value
		return
	}
	at := g.cur
	for i, key := range path {
		last := i == len(path)-1
		switch k := key.(type) {
		case string:
			m, ok := at.(map[string]any)
			if !ok {
				g.t.Fatalf("%s: %v is not an object", g.path, path[:i])
			}
			if last {
				m[k] = value
				return
			}
			at = m[k]
		case int:
			a, ok := at.([]any)
			if !ok || k >= len(a) {
				g.t.Fatalf("%s: %v is not an array that long", g.path, path[:i])
			}
			if last {
				a[k] = value
				return
			}
			at = a[k]
		}
	}
}

func (g *goldenCases) close() {
	if !*update {
		return
	}
	var out bytes.Buffer
	zipped := gzip.NewWriter(&out)
	for _, line := range g.out {
		zipped.Write(line)
		zipped.Write([]byte("\n"))
	}
	if err := zipped.Close(); err != nil {
		g.t.Fatal(err)
	}
	if err := os.WriteFile(g.path, out.Bytes(), 0o644); err != nil {
		g.t.Fatal(err)
	}
}

func recorded(got any, path ...any) bool {
	if !*update || recording == nil {
		return false
	}
	recording.set(got, path...)
	return true
}

const sampleState = `{
  "call": "live", "foreman": "speaking", "reports": [],
  "helpers": [{
    "id": "w1", "name": "Pi 实验员", "agent": "lab", "runtime": "pi", "task": "写打卡", "hiredAt": 1, "turns": 1,
    "phase": {"_tag": "working", "since": 2, "doing": {"action": "edit_file", "label": "改 checkin.ts"}},
    "play": {
      "station": 2, "history": [{"at": 2, "action": "edit_file", "label": "src/checkin.ts"}], "toolsThisTurn": 1,
      "counts": {"edit_file": 1}, "files": ["src/checkin.ts"], "commands": [], "turnStartedAt": 2
    }
  }],
  "chat": {
    "conversations": [{"id": 1, "kind": "square", "replies": 0, "at": 1}],
    "messages": [
      {"seq": 1, "conversation": 1, "from": "user", "fromKind": "user", "name": "主人", "kind": "chat", "text": "让 Pi 实验员写打卡", "final": true, "at": 1},
      {"seq": 2, "conversation": 1, "from": "foreman", "fromKind": "foreman", "name": "管家", "kind": "chat", "text": "好，派给 Pi 实验员了", "final": false, "at": 2}
    ]
  }
}`

func TestSiteFrameSample(t *testing.T) {
	var frame SiteFrame
	if err := json.Unmarshal([]byte(`{"state": `+sampleState+`, "view": {}, "effects": [{"kind": "levelUp", "level": 2}]}`), &frame); err != nil {
		t.Fatal(err)
	}
	frame.View = ViewOf(frame.State)
	golden(t, "../../../app/schema/site-frame.sample.json", indented(t, frame))
}
