package protocol

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"vibevalley/internal/golden"
)

// coreNull is a Go result as the cases write it: null for an empty string.
func coreNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func coreSame(t *testing.T, line int, fn string, input json.RawMessage, got any, want json.RawMessage) bool {
	t.Helper()
	if golden.Recorded(got, "out") {
		return true
	}
	body, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("line %d %s: %v", line, fn, err)
	}
	var a, b any
	_ = json.Unmarshal(body, &a)
	_ = json.Unmarshal(want, &b)
	if !reflect.DeepEqual(a, b) {
		t.Errorf("line %d %s(%s):\n got %s\nwant %s", line, fn, input, body, want)
		return false
	}
	return true
}

func coreDecode(t *testing.T, line int, raw json.RawMessage, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("line %d: %v: %s", line, err, raw)
	}
}

// Times of day are read in Asia/Shanghai.
func TestRulesGolden(t *testing.T) {
	zone, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	was := time.Local
	time.Local = zone
	defer func() { time.Local = was }()

	cases := golden.Read(t, "testdata/rules.jsonl.gz")
	line, failed := 0, 0
	seen := map[string]int{}
	for _, body := range cases.Lines {
		if failed >= 20 {
			break
		}
		line++
		cases.Begin(line)
		var row struct {
			Fn  string          `json:"fn"`
			In  json.RawMessage `json:"in"`
			Out json.RawMessage `json:"out"`
		}
		coreDecode(t, line, body, &row)
		seen[row.Fn]++
		same := func(got any) {
			t.Helper()
			if !coreSame(t, line, row.Fn, row.In, got, row.Out) {
				failed++
			}
		}
		switch row.Fn {
		case "targetOf":
			var in struct {
				C           Conversation `json:"c"`
				ChannelName *string      `json:"channelName"`
			}
			coreDecode(t, line, row.In, &in)
			same(TargetOf(in.C, in.ChannelName))
		case "phaseText":
			var in struct {
				Worker Worker `json:"worker"`
				Now    int64  `json:"now"`
			}
			coreDecode(t, line, row.In, &in)
			same(PhaseText(in.Worker, in.Now))
		case "yuan":
			var cny float64
			coreDecode(t, line, row.In, &cny)
			same(Yuan(cny))
		default:
			t.Fatalf("line %d: unknown fn %q", line, row.Fn)
		}
		cases.End()
	}
	cases.Close()
	// Every rule this test knows has cases (the other rules' cases live with them: channel, connector, setting, memory, runtime, manager, schedule).
	if len(seen) != 3 {
		t.Fatalf("rules seen: %v", seen)
	}
	t.Logf("%d calls: %v", line, seen)
}
