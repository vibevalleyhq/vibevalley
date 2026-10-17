// Package golden keeps the rules' recorded cases and golden files, for whichever package owns the rules: testdata/*.jsonl.gz
// are seeded random inputs with what the rules make of them, compared on every run. With VIBEVALLEY_GOLDEN=update the
// tests write them again from what the Go makes now (VIBEVALLEY_GOLDEN=update go test ./internal/...); then read the diff.
// Only tests import it, and it imports nothing of the farm's, so protocol's own tests can.
package golden

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func Updating() bool { return os.Getenv("VIBEVALLEY_GOLDEN") == "update" }

// File compares body with the file at path, or writes it there when updating.
func File(t *testing.T, path string, body []byte) {
	t.Helper()
	if Updating() {
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
		t.Fatalf("%s is stale: VIBEVALLEY_GOLDEN=update go test ./internal/...", path)
	}
}

func Indented(t *testing.T, v any) []byte {
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

// Each case's expected parts are compared with what the Go rules make; when updating, Set replaces them and Close writes
// the file back. One file at a time: Read makes it the one Recorded writes into.
type Cases struct {
	t     *testing.T
	path  string
	Lines [][]byte
	out   [][]byte
	cur   any
}

var recording *Cases

func Read(t *testing.T, path string) *Cases {
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
	g := &Cases{t: t, path: path}
	for scanner.Scan() {
		g.Lines = append(g.Lines, bytes.Clone(scanner.Bytes()))
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

// Begin and End bracket the case on that line (from 1).
func (g *Cases) Begin(line int) {
	if Updating() {
		g.cur = decodeLoose(g.Lines[line-1])
	}
}

func (g *Cases) End() {
	if Updating() {
		body, err := json.Marshal(g.cur)
		if err != nil {
			g.t.Fatal(err)
		}
		g.out = append(g.out, body)
	}
}

// Set puts got at path (object keys and array indexes) in the current case.
func (g *Cases) Set(got any, path ...any) {
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

func (g *Cases) Close() {
	if !Updating() {
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

// Recorded, when updating, puts got into the case being read and says so: the test then does not compare.
func Recorded(got any, path ...any) bool {
	if !Updating() || recording == nil {
		return false
	}
	recording.Set(got, path...)
	return true
}

// One recorded call of a rule: its name, its input, and what it made.
type Case struct {
	Line    int
	Fn      string          `json:"fn"`
	In, Out json.RawMessage `json:"-"`
}

// Decode reads a case's input or output into v.
func (c Case) Decode(t *testing.T, raw json.RawMessage, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("line %d %s: %v: %s", c.Line, c.Fn, err, raw)
	}
}

// Rules runs every case in path through rule, which answers what that rule makes of the case's input (a rule it does not
// know is a failure), and compares it with what was recorded; when updating, it records it instead. It says how many
// calls of each rule it saw.
func Rules(t *testing.T, path string, rule func(c Case) any) map[string]int {
	t.Helper()
	cases := Read(t, path)
	seen := map[string]int{}
	failed := 0
	for i, body := range cases.Lines {
		if failed >= 20 {
			break
		}
		cases.Begin(i + 1)
		var row struct {
			Fn  string          `json:"fn"`
			In  json.RawMessage `json:"in"`
			Out json.RawMessage `json:"out"`
		}
		if err := json.Unmarshal(body, &row); err != nil {
			t.Fatalf("%s line %d: %v", path, i+1, err)
		}
		c := Case{Line: i + 1, Fn: row.Fn, In: row.In, Out: row.Out}
		seen[c.Fn]++
		got := rule(c)
		if !Recorded(got, "out") {
			body, err := json.Marshal(got)
			if err != nil {
				t.Fatalf("line %d %s: %v", c.Line, c.Fn, err)
			}
			var a, b any
			_ = json.Unmarshal(body, &a)
			_ = json.Unmarshal(row.Out, &b)
			if !reflect.DeepEqual(a, b) {
				t.Errorf("line %d %s(%s):\n got %s\nwant %s", c.Line, c.Fn, row.In, body, row.Out)
				failed++
			}
		}
		cases.End()
	}
	cases.Close()
	return seen
}

// Null is a result as the cases write it: null for an empty string.
func Null(s string) any {
	if s == "" {
		return nil
	}
	return s
}
